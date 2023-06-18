import { EventDef, RouterDef } from "@teb/core";
import { createFlatProxy, createRecursiveProxy } from "@teb/core/proxy";
import { Emitter, createNanoEvents } from "nanoevents";
import React, { useContext, useEffect, useRef } from "react";
import { ReadyState } from "react-use-websocket";
import { useWebSocket } from "react-use-websocket/dist/lib/use-websocket";
import { z } from "zod";

type EmitterEventMap = {
  event(path: string[], data: any): void;
};

type EventHookType<EventType extends EventDef<any, any>> = {
  useEvent: (
    callback: (
      input: EventType extends EventDef<any, infer DataType>
        ? DataType extends z.ZodType<any, any, any>
          ? z.infer<DataType>
          : undefined
        : never
    ) => void | Promise<void>
  ) => void;
};

type ConsumerType<RouterType extends RouterDef<any, any>> = {
  [x in keyof RouterType["__children"]]: RouterType["__children"][x] extends EventDef<
    any,
    any
  >
    ? EventHookType<RouterType["__children"][x]>
    : RouterType["__children"][x] extends RouterDef<any, any>
    ? ConsumerType<RouterType["__children"][x]>
    : never;
};

export function createConsumer<
  RouterType extends RouterDef<any, any>
>(config?: { verbose?: boolean }) {
  const log = (...args: any[]) =>
    config?.verbose ? console.log(...args) : void null;

  const BrokerContext = React.createContext<{
    emitterRef: React.MutableRefObject<Emitter<EmitterEventMap>>;
    readyState: ReadyState;
  }>({ emitterRef: undefined!, readyState: ReadyState.UNINSTANTIATED });

  const Provider: React.FC<{ url: string; children: React.ReactNode }> = ({
    url,
    children,
  }) => {
    const emitter = useRef(createNanoEvents<EmitterEventMap>());

    const { readyState } = useWebSocket(url, {
      onOpen() {
        log(`@teb/react: Connected to url: ${url}`);
      },
      onMessage(event) {
        try {
          const parsed = JSON.parse(event.data) as {
            timestamp: number;
            event: { path: string[]; data: any };
          };
          emitter.current.emit("event", parsed.event.path, parsed.event.data);
        } catch (e) {
          console.error("Encountered invalid event");
        }
      },
    });

    return (
      <BrokerContext.Provider value={{ emitterRef: emitter, readyState }}>
        {children}
      </BrokerContext.Provider>
    );
  };

  type Consumer = ConsumerType<RouterType>;

  return createFlatProxy<Consumer & { Provider: typeof Provider }>(
    (headPathPart) => {
      if (headPathPart === "Provider") return Provider;
      return createRecursiveProxy(async ({ path, args }) => {
        const combinedPath = [headPathPart, ...path];

        if (combinedPath[combinedPath.length - 1] !== "useEvent")
          throw new Error("Something went horribly wrong.");

        const context = useContext(BrokerContext);

        useEffect(() => {
          const callback = args[0] as (data: any) => void | Promise<void>;
          const eventPath = combinedPath.slice(0, combinedPath.length - 1);

          const unbind = context.emitterRef.current.on(
            "event",
            (receivedPath, data) => {
              if (receivedPath.join(".") === eventPath.join(".")) {
                callback(data);
              }
            }
          );

          return () => unbind();
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);
      });
    }
  );
}
