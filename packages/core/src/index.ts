import { z } from "zod";

export type EventDef<
  _ContextType extends any,
  DataType extends z.ZodType<any, any, any>
> = {
  __type: "event";
  __data?: DataType;
};

export type RouterDef<
  ContextType extends any,
  ChildrenType extends EventRouterRecord<ContextType>
> = {
  __type: "router";
  __children: ChildrenType;
};

type EventRouterRecord<ContextType extends any> = {
  [key: string]: EventDef<ContextType, any> | RouterDef<ContextType, any>;
};

export function createBroker<ContextType extends any = undefined>() {
  return {
    router: <ChildrenType extends EventRouterRecord<ContextType>>(
      children: ChildrenType
    ) => ({
      __type: "router" as const,
      __children: children,
    }),
    event: <DataType extends z.ZodType<any, any, any>>(data?: DataType) => ({
      __type: "event" as const,
      __data: data,
    }),
  };
}
