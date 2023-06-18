# TEDS - Typed event dispatch system

## Getting started

This guide assumes you use Cloudflare Workers and React.

Install the following in your API directory:

```
pnpm add zod @teds/core @teds/cloudflare
```

Install the following in your web directory:

```
pnpm add zod @teds/react
```

### Server side

This guide assumes you have a Durable Object bound to your worker named `PRODUCER_DO`.

Define your events using zod schemas:

```ts
import { createProducer } from "@teds/cloudflare";
import { createBroker } from "@teds/core";

// The following can be split up among multiple files:

export const broker = createBroker();

const memberUpdatedEvent = broker.event(
  z.object({
    memberId: z.string().ulid(),
  })
);

export const memberEventRouter = broker.router({
  memberUpdated: memberUpdatedEvent,
});

export const rootEventRouter = broker.router({
  member: memberEventRouter,
});

// This is your DurableObject class
export class Producer extends createProducer() {
  router = rootEventRouter;
}
export type rootEventRouter = typeof rootEventRouter;
```

Make sure to expose the WS endpoint in your routing code and export your durable object class from the root of your main script file. Here's an example that uses hono for routing:

```ts
import { createDispatcherProxy, subscribe } from "@teds/cloudflare";
import { Hono } from "hono";

import { rootEventRouter } from "./producer.ts";

export type Env = {
  PRODUCER_DO: DurableObjectNamespace;
};

export type HonoBindings = {
  Bindings: Env;
};

const app = new Hono<HonoBindings>();

const route = app
  .on(["GET"], "/api/events/user/:id", ({ env, req }) => {
    const userId = req.param("id");

    // Route incoming request to the Durable Object
    // and return a WebSocket connection
    return subscribe(env.PRODUCER_DO, userId, req.raw);
  })
  .on(["POST"], "/api/member/update", async ({ env, req }) => {
    const userId = "123";

    // This factory code could be hidden away in a context creator
    const dispatcher = createDispatcherProxy(
      rootEventRouter,
      env.WORKSPACE_PRODUCER,

      // This third parameter controls the instance you connect to
      // this could be based on user ID, org ID etc.
      userId
    );

    // Dispatch an event
    await dispatcher.member.memberUpdated({
      memberId: "123",
    });
  });

export default app;

export { Producer } from "./producer.ts";
```

Your server should now be ready to go! On to the client...

### Client side

Create a file called teds.ts that exports a consumer:

```ts
import { createConsumer } from "@teds/react";
import { type rootEventRouter } from "[SOMEWHERE IN YOUR DB CODE]";

export const eventConsumer = createConsumer<rootEventRouter>();
```

Wrap your app or the part of your app that uses events with the provider:

```tsx
const App = () => {
  const userId = "123";

  return (
    <eventConsumer.Provider
      url={`ws://localhost:8787/api/events/user/${userId}`}
    >
      {/* ... */}
    </eventConsumer.Provider>
  );
};
```

Now your componens can use the typed event hooks to react to events.

```tsx
const MemberDetails = () => {
  eventConsumer.member.memberUpdated.useEvent(({ memberId }) => {
    console.log(`Member ${memberId} updated!`);
  });

  return <div>{/* ... */}</div>;
};
```

That's about it!
