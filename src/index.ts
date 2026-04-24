import { Hono } from "hono";

type Bindings = {
  CACHE: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => {
  return c.json({ status: "ok", version: "0.1.0" });
});

export default app;
