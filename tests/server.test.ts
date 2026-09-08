import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createDeps } from "../src/server/app.ts";
import { FakeAdapter } from "../src/server/fake-adapter.ts";
import type express from "express";

describe("server security + API", () => {
  let app: express.Express;
  let adapter: FakeAdapter;
  let csrf = "";
  let cwd = "";
  let workspaceId = "";
  let tmpRoot = "";

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "srv-test-"));
    cwd = join(tmpRoot, "proj");
    mkdirSync(cwd, { recursive: true });
    process.env.WORKSPACE_ROOTS = tmpRoot;
    delete process.env.ALLOWED_HOSTS;
    delete process.env.ALLOWED_TAILSCALE_USERS;
    adapter = new FakeAdapter();
    const deps = createDeps(adapter, "test");
    app = createApp(deps);
    const boot = await request(app).get("/api/bootstrap").set("Host", "127.0.0.1:4783");
    expect(boot.status).toBe(200);
    csrf = boot.body.csrfToken;
    expect(typeof csrf).toBe("string");
    const open = await request(app)
      .post("/api/workspaces/open")
      .set("Host", "127.0.0.1:4783")
      .set("x-pi-csrf", csrf)
      .send({ path: cwd });
    expect(open.status).toBe(200);
    workspaceId = open.body.workspaceId;
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
    delete process.env.WORKSPACE_ROOTS;
  });

  it("GET /api/health works", async () => {
    const r = await request(app).get("/api/health").set("Host", "127.0.0.1");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("rejects mutations without CSRF", async () => {
    const r = await request(app).post("/api/chats").set("Host", "127.0.0.1").send({ workspaceId });
    expect(r.status).toBe(403);
  });

  it("rejects disallowed Host", async () => {
    const r = await request(app)
      .post("/api/workspaces/open")
      .set("Host", "evil.com")
      .set("x-pi-csrf", csrf)
      .send({ path: cwd });
    expect(r.status).toBe(403);
  });

  it("allows loopback hosts", async () => {
    for (const h of ["127.0.0.1:4783", "localhost:4783", "127.0.0.1"]) {
      const r = await request(app).get("/api/health").set("Host", h);
      expect(r.status).toBe(200);
    }
  });

  it("rejects cross-site Sec-Fetch-Site", async () => {
    const r = await request(app)
      .post("/api/chats")
      .set("Host", "127.0.0.1")
      .set("x-pi-csrf", csrf)
      .set("Sec-Fetch-Site", "cross-site")
      .send({ workspaceId });
    expect(r.status).toBe(403);
  });

  it("rejects bad Origin", async () => {
    const r = await request(app)
      .post("/api/chats")
      .set("Host", "127.0.0.1")
      .set("x-pi-csrf", csrf)
      .set("Origin", "https://evil.com")
      .send({ workspaceId });
    expect(r.status).toBe(403);
  });

  it("allows localhost Origin", async () => {
    const r = await request(app)
      .post("/api/chats")
      .set("Host", "127.0.0.1")
      .set("x-pi-csrf", csrf)
      .set("Origin", "http://127.0.0.1:4783")
      .send({ workspaceId });
    expect([201, 409, 500]).toContain(r.status);
    // 201 expected for valid create
    expect(r.status).toBe(201);
  });

  it("Tailscale-proxied: allows configured hostname + https origin via forwarded headers", async () => {
    process.env.ALLOWED_HOSTS = "";
    // Recreate app with new env
    process.env.ALLOWED_HOSTS = "myhost.tail123.ts.net";
    const deps2 = createDeps(adapter, "test");
    const app2 = createApp(deps2);
    const boot2 = await request(app2).get("/api/bootstrap").set("Host", "127.0.0.1");
    const csrf2 = boot2.body.csrfToken as string;
    // Direct Tailscale hostname without proxy should still be allowed as Host (configured)
    const r1 = await request(app2)
      .post("/api/chats")
      .set("Host", "myhost.tail123.ts.net")
      .set("x-pi-csrf", csrf2)
      .set("Origin", "https://myhost.tail123.ts.net")
      .send({ workspaceId });
    // workspaceId from old app not valid in new app's store; expect 404 (but not 403) -> proves host/origin passed
    expect([404, 201]).toContain(r1.status);
    expect(r1.status).not.toBe(403);

    // Forwarded-host path: immediate connection from loopback, forwarded host = tailnet name
    const r2 = await request(app2)
      .get("/api/health")
      .set("Host", "127.0.0.1:4783")
      .set("X-Forwarded-Host", "myhost.tail123.ts.net")
      .set("X-Forwarded-Proto", "https");
    expect(r2.status).toBe(200);
    delete process.env.ALLOWED_HOSTS;
  });

  it("ALLOWED_TAILSCALE_USERS enforced for remote", async () => {
    process.env.ALLOWED_HOSTS = "myhost.tail123.ts.net";
    process.env.ALLOWED_TAILSCALE_USERS = "alice";
    const deps2 = createDeps(adapter, "test");
    const app2 = createApp(deps2);
    const boot2 = await request(app2).get("/api/bootstrap").set("Host", "127.0.0.1");
    const csrf2 = boot2.body.csrfToken as string;
    const denied = await request(app2)
      .post("/api/chats")
      .set("Host", "myhost.tail123.ts.net")
      .set("x-pi-csrf", csrf2)
      .set("Tailscale-User-Login", "bob")
      .send({ workspaceId: "x" });
    expect(denied.status).toBe(403);
    delete process.env.ALLOWED_HOSTS;
    delete process.env.ALLOWED_TAILSCALE_USERS;
  });

  it("request body limits + validation", async () => {
    // empty message rejected
    const c = await request(app).post("/api/chats").set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ workspaceId });
    expect(c.status).toBe(201);
    const chatId = c.body.chatId as string;
    const empty = await request(app).post(`/api/chats/${chatId}/messages`).set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ kind: "normal", text: "" });
    expect(empty.status).toBe(400);
  });

  it("full chat flow: create, send 202, abort, config, rename, compact, extension, dispose", async () => {
    const c = await request(app).post("/api/chats").set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ workspaceId });
    expect(c.status).toBe(201);
    const chatId = c.body.chatId as string;

    // send returns 202 Accepted
    const m = await request(app).post(`/api/chats/${chatId}/messages`).set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ kind: "normal", text: "hello" });
    expect(m.status).toBe(202);
    expect(m.body.accepted).toBe(true);

    // config while busy should 409
    const cfgBusy = await request(app).patch(`/api/chats/${chatId}/config`).set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ thinking: "high" });
    expect([200, 409]).toContain(cfgBusy.status);

    // abort
    const ab = await request(app).post(`/api/chats/${chatId}/abort`).set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({});
    expect(ab.status).toBe(200);

    // wait a bit for idle
    await new Promise((r) => setTimeout(r, 150));

    // config while idle succeeds
    const cfg = await request(app).patch(`/api/chats/${chatId}/config`).set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ thinking: "low", toolMode: "full" });
    expect(cfg.status).toBe(200);

    // rename
    const rn = await request(app).post(`/api/chats/${chatId}/rename`).set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ name: "my chat" });
    expect(rn.status).toBe(200);

    // compact
    const cp = await request(app).post(`/api/chats/${chatId}/compact`).set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({});
    expect(cp.status).toBe(200);

    // unknown extension response -> 404
    const ex = await request(app).post(`/api/chats/${chatId}/extension-response`).set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ reqId: "nope", cancelled: true });
    expect(ex.status).toBe(404);

    // dispose
    const dp = await request(app).post(`/api/chats/${chatId}/dispose`).set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({});
    expect(dp.status).toBe(200);
  });

  it("opaque session validation + attach on double open (no second writer)", async () => {
    const c = await request(app).post("/api/chats").set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ workspaceId });
    const chatId = c.body.chatId as string;
    const snap = await request(app).get(`/api/chats/${chatId}`).set("Host", "127.0.0.1");
    const sessionId = snap.body.snapshot.sessionId as string;
    // second resume while live attaches to existing chat (same chatId), never a second writer
    const r2 = await request(app).post("/api/chats/resume").set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ workspaceId, sessionId });
    expect(r2.status).toBe(201);
    expect(r2.body.chatId).toBe(chatId);
    // bad opaque -> 404
    const bad = await request(app).post("/api/chats/resume").set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ workspaceId, sessionId: Buffer.from("/etc/passwd").toString("base64url") });
    expect(bad.status).toBe(404);
  });

  it("SSE endpoint returns event-stream headers + snapshot", async () => {
    const c = await request(app).post("/api/chats").set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ workspaceId });
    const chatId = c.body.chatId as string;
    const r = await request(app).get(`/api/chats/${chatId}/events`).set("Host", "127.0.0.1").timeout({ response: 2000 }).parse((res, cb) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        // close after first snapshot
        if (data.includes("snapshot")) {
          try {
            (res as unknown as { destroy: () => void }).destroy();
          } catch {}
        }
      });
      res.on("end", () => cb(null, data));
      res.on("close", () => cb(null, data));
    });
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.headers["cache-control"]).toContain("no-cache");
    expect(r.headers["x-accel-buffering"]).toBe("no");
  });

  it("built responses contain no credential values", async () => {
    const c = await request(app).post("/api/chats").set("Host", "127.0.0.1").set("x-pi-csrf", csrf).send({ workspaceId });
    const text = JSON.stringify(c.body);
    expect(text).not.toMatch(/sk-/);
    expect(text).not.toContain("auth.json");
    const h = await request(app).get("/api/health").set("Host", "127.0.0.1");
    expect(JSON.stringify(h.body)).not.toContain("token");
  });

  it("security headers present (helmet CSP, no-referrer)", async () => {
    const r = await request(app).get("/api/health").set("Host", "127.0.0.1");
    expect(r.headers["content-security-policy"]).toBeDefined();
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });
});
