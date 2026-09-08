import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import express from "express";
import { createApp, createDeps } from "./app.js";
import { FakeAdapter } from "./fake-adapter.js";
import { RealAdapter } from "./real-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parsePort(): number {
  const raw = process.env.PORT ?? "4783";
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    // eslint-disable-next-line no-console
    console.error(`Invalid PORT "${raw}": must be an integer 1024–65535`);
    process.exit(1);
  }
  return n;
}

async function main(): Promise<void> {
  if (process.env.HOST) {
    // eslint-disable-next-line no-console
    console.error("HOST override is not allowed; server always binds to 127.0.0.1 for safety.");
    process.exit(1);
  }
  const port = parsePort();
  const host = "127.0.0.1";
  const useFake = process.env.PI_WEBUI_USE_FAKE === "1";
  const adapter = useFake ? new FakeAdapter() : new RealAdapter();
  const deps = createDeps(adapter);
  const app = createApp(deps);

  // Serve built frontend from one production process (dist/client)
  // In compiled layout dist/server/index.js -> dist/client is ../client
  const clientDir = path.resolve(__dirname, "../client");
  if (existsSync(clientDir)) {
    app.use(express.static(clientDir, { index: false, maxAge: "1h" }));
    // SPA fallback for non-API routes
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
  } else {
    // eslint-disable-next-line no-console
    console.warn(`Built client not found at ${clientDir}; API-only mode. Run 'npm run build' first.`);
  }

  const server = createServer(app);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // eslint-disable-next-line no-console
      console.error(`Port ${port} is already in use. Stop the other process or set PORT=1024–65535 to use another port.`);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`pi-web-ui listening on http://127.0.0.1:${port} (${useFake ? "fake" : "real"} Pi adapter, pi ${deps.piVersion})`);
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
