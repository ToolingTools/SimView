#!/usr/bin/env bun
export { createServer, runServer } from "./server";
export { SimViewSession } from "./session";

if (import.meta.main) {
  const { runServer } = await import("./server");
  await runServer();
}
