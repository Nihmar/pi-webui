import { createServer } from "node:http";
import { createApp, createDeps } from "./app.js";
import { FakeAdapter } from "./fake-adapter.js";
import { RealAdapter } from "./real-adapter.js";

const port = Number.parseInt(process.env.PORT ?? "4783", 10) || 4783;
const host = "127.0.0.1";
const useFake = process.env.PI_WEBUI_USE_FAKE !== "0";
const adapter = useFake ? new FakeAdapter() : new RealAdapter();
const deps = createDeps(adapter);
const app = createApp(deps);
const server = createServer(app);
server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`dev server on http://127.0.0.1:${port} (${useFake ? "fake" : "real"})`);
});
