import { EventDef, RouterDef } from "@teb/core";
import { createRecursiveProxy } from "@teb/core/proxy";
import { z } from "zod";

const ProducerErrorCodes = {
  PATH_MISSING: "Path missing from query",
  EVENT_NOT_FOUND: "Event not found",
  CANT_ENTER_EVENT:
    "Attempted to access subroute of event, which is impossible",
  CANT_CALL_ROUTER: "Attempted to call router instead of event",
  INVALID_JSON: "Event data contained invalid JSON",
  INVALID_DATA: "Event data didn't match schema",
  INVALID_REQUEST: "Invalid request",
} as const;
type ProducerErrorCode = keyof typeof ProducerErrorCodes;

class ProducerError extends Error {
  constructor(code: ProducerErrorCode, message?: string) {
    const innerMessage = `${ProducerErrorCodes[code]}${
      message ? ` ${message}` : ""
    }`;
    super(innerMessage);
    this.name = "Producer error";
  }
}

const createErrorResponse = (errorCode: ProducerErrorCode) => {
  return new Response(errorCode, {
    status: 400,
  });
};

const parseErrorResponse = async (response: Response) => {
  const code = (await response.text()) as ProducerErrorCode;
  if (!ProducerErrorCodes[code]) throw new Error("Unknown error");
  throw new ProducerError(code);
};

const parseData = async <ContextType extends any>(
  request: Request<unknown, CfProperties<unknown>>,
  path: string[],
  definition: EventDef<ContextType, any>
) => {
  if (!definition.__data) return { type: "success" as const, data: undefined };

  try {
    const json = await request.json();
    const parsed = await definition.__data.safeParseAsync(json);
    if (parsed.success) {
      return { type: "success" as const, data: parsed.data };
    }
    console.error(`Invalid data for event: ${path.join(".")}`);
    console.error(parsed.error);
    return { type: "error" as const, errorCode: "INVALID_DATA" as const };
  } catch {
    return { type: "error" as const, errorCode: "INVALID_JSON" as const };
  }
};

const traverseRouter = <
  ContextType extends any,
  RouterType extends RouterDef<ContextType, any>
>(
  router: RouterType,
  pathParts: string[]
) => {
  let currentNode: RouterDef<ContextType, any> | EventDef<ContextType, any> =
    router;
  if (!currentNode)
    return { type: "error", errorCode: "EVENT_NOT_FOUND" } as const;

  for (const part of pathParts) {
    if (currentNode.__type === "event")
      return { type: "error", errorCode: "CANT_ENTER_EVENT" } as const;
    currentNode = currentNode["__children"][part];
    if (!currentNode)
      return { type: "error", errorCode: "EVENT_NOT_FOUND" } as const;
  }
  return { type: "success" as const, node: currentNode };
};

export const createProducer = () => {
  abstract class ProducerDO implements DurableObject {
    connections = new Map<string, { id: string; socket: WebSocket }>();
    abstract router: RouterDef<any, any>;

    async handleSession(
      _request: Request<unknown, CfProperties<unknown>>,
      socket: WebSocket
    ) {
      const id = crypto.randomUUID();
      socket.accept();

      this.connections.set(id, { id, socket });

      socket.addEventListener("close", () => {
        this.connections.delete(id);
      });
    }

    async dispatchServerSide(path: string[], data: any) {
      const timestamp = Date.now();
      const message = JSON.stringify({ timestamp, event: { path, data } });
      for (const [_id, connection] of this.connections) {
        connection.socket.send(message);
      }
    }

    async handleDispatch(request: Request<unknown, CfProperties<unknown>>) {
      const url = new URL(request.url);

      const path = url.searchParams.get("path");
      if (!path) return createErrorResponse("PATH_MISSING");

      const pathParts = path.split(".");
      const result = traverseRouter(this.router, pathParts);
      debugger;

      if (result.type == "error") return createErrorResponse(result.errorCode);
      const node = result.node;

      if (node.__type === "router")
        return createErrorResponse("CANT_CALL_ROUTER");

      const dataResult = await parseData(request, pathParts, node);
      if (dataResult.type === "error")
        return createErrorResponse(dataResult.errorCode);

      await this.dispatchServerSide(pathParts, dataResult.data);

      return new Response("OK", { status: 200 });
    }

    async fetch(
      request: Request<unknown, CfProperties<unknown>>
    ): Promise<Response> {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/subscribe": {
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", { status: 400 });
          }
          const { [0]: client, [1]: server } = new WebSocketPair();
          await this.handleSession(request, server);

          return new Response(null, { status: 101, webSocket: client });
        }

        case "/dispatch": {
          return this.handleDispatch(request);
        }

        default: {
          return createErrorResponse("INVALID_REQUEST");
        }
      }
    }
  }

  return ProducerDO;
};

type EventCallerType<
  ContextType extends any,
  EventType extends EventDef<ContextType, any>
> = (
  input: EventType extends EventDef<ContextType, infer DataType>
    ? DataType extends z.ZodType<any, any, any>
      ? z.infer<DataType>
      : undefined
    : never
) => Promise<void>;

type DispatcherType<
  ContextType extends any,
  RouterType extends RouterDef<ContextType, any>
> = {
  [x in keyof RouterType["__children"]]: RouterType["__children"][x] extends EventDef<
    ContextType,
    any
  >
    ? EventCallerType<ContextType, RouterType["__children"][x]>
    : RouterType["__children"][x] extends RouterDef<ContextType, any>
    ? DispatcherType<ContextType, RouterType["__children"][x]>
    : never;
};

export const createDispatcherProxy = <
  ContextType extends any,
  RouterType extends RouterDef<ContextType, any>
>(
  router: RouterType,
  durableObjectNamespace: DurableObjectNamespace,
  instanceName: string
) => {
  router;

  return createRecursiveProxy(async ({ path, args }) => {
    const instanceId = durableObjectNamespace.idFromName(instanceName);
    const instance = durableObjectNamespace.get(instanceId);

    const data = args[0];

    const response = await instance.fetch(
      new Request(
        `http://dummy.url/dispatch?${new URLSearchParams({
          path: path.join("."),
        })}`,
        {
          body: data ? JSON.stringify(data) : undefined,
          method: "POST",
        }
      )
    );

    if (!response.ok) await parseErrorResponse(response);
  }) as DispatcherType<ContextType, RouterType>;
};

export const subscribe = (
  namespace: DurableObjectNamespace,
  instanceName: string,
  request: Request<unknown, CfProperties<unknown>>
) => {
  const id = namespace.idFromName(instanceName);
  return namespace
    .get(id)
    .fetch(new Request("http://dummy.url/subscribe", request));
};
