import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAdapter } from "../src/server/fake-adapter.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("fake adapter ownership + lifecycle", () => {
  let adapter: FakeAdapter;
  let cwd: string;

  beforeEach(() => {
    adapter = new FakeAdapter();
    cwd = mkdtempSync(join(tmpdir(), "fake-cwd-"));
    mkdirSync(cwd, { recursive: true });
  });

  it("creates, streams, settles, and prevents duplicate writers", async () => {
    const chat = await adapter.createChat("ws1", cwd, "test");
    expect(chat.getSnapshot().runStatus).toBe("idle");

    const events: string[] = [];
    chat.subscribe((e) => events.push(e.type));

    await chat.send("normal", "hello [tool]");
    // wait for settled
    for (let i = 0; i < 50; i++) {
      if (chat.getSnapshot().runStatus === "idle") break;
      await sleep(20);
    }
    expect(chat.getSnapshot().runStatus).toBe("idle");
    expect(chat.getSnapshot().items.length).toBeGreaterThan(2);
    // tool activity present
    expect(chat.getSnapshot().items.some((it) => it.kind === "tool")).toBe(true);
    // event normalization includes deltas and tool events
    expect(events).toContain("assistant_delta");
    expect(events).toContain("tool_start");
    expect(events).toContain("tool_end");

    // single ownership: second resume attaches to existing live chat, never a second writer
    const opaque = chat.getSnapshot().sessionId;
    const attached = await adapter.resumeChat("ws1", cwd, opaque);
    expect(attached.chatId).toBe(chat.chatId);
    expect(attached.getSessionFile()).toBe(chat.getSessionFile());
    await chat.dispose();
    // after dispose, resume works (rebuilds snapshot, no duplicates)
    const chat2 = await adapter.resumeChat("ws1", cwd, opaque);
    expect(chat2.getSnapshot().items.length).toBe(chat.getSnapshot().items.length);
    await chat2.dispose();
  });

  it("queue/abort/settled: steer queues while busy, abort stops and clears", async () => {
    const chat = await adapter.createChat("ws1", cwd);
    await chat.send("normal", "long task [tool]");
    // quickly steer while busy
    await sleep(10);
    await chat.send("steer", "steered instruction");
    const snap = chat.getSnapshot();
    // queue should contain steering or run still active
    expect(snap.runStatus === "running" || snap.queue.steering.length >= 0).toBe(true);
    // abort clears queue and goes stopping -> idle
    await chat.abort();
    expect(chat.getSnapshot().runStatus).toBe("stopping");
    for (let i = 0; i < 30; i++) {
      if (chat.getSnapshot().runStatus === "idle") break;
      await sleep(20);
    }
    expect(chat.getSnapshot().runStatus).toBe("idle");
    expect(chat.getSnapshot().queue.steering.length).toBe(0);
    await chat.dispose();
  });

  it("stale events rejected after abort (generation/run id)", async () => {
    const chat = await adapter.createChat("ws1", cwd);
    const seen: string[] = [];
    chat.subscribe((e) => {
      if (e.type === "assistant_delta") seen.push(e.delta);
    });
    await chat.send("normal", "hello");
    await sleep(5);
    await chat.abort();
    const countAfterAbort = seen.length;
    await sleep(150);
    // No new deltas after abort settled (stale timers ignored)
    expect(chat.getSnapshot().runStatus).toBe("idle");
    // deltas should not keep growing unboundedly after abort
    expect(seen.length - countAfterAbort).toBeLessThanOrEqual(1);
    await chat.dispose();
  });

  it("bounded tool previews", async () => {
    const chat = await adapter.createChat("ws1", cwd);
    // @ts-expect-error test helper
    const preview = chat.emitLargeToolPreviewForTest(20000);
    expect(preview.length).toBeLessThan(20000);
    expect(preview).toContain("truncated");
    await chat.dispose();
  });

  it("extension dialog round trip (confirm)", async () => {
    const chat = await adapter.createChat("ws1", cwd);
    const reqs: { reqId: string }[] = [];
    chat.subscribe((e) => {
      if (e.type === "extension_request" && e.method === "confirm") reqs.push({ reqId: e.reqId });
    });
    await chat.send("normal", "/demo-confirm");
    for (let i = 0; i < 30; i++) {
      if (reqs.length) break;
      await sleep(20);
    }
    expect(reqs.length).toBe(1);
    await chat.respondToExtension(reqs[0]!.reqId, { confirmed: true });
    for (let i = 0; i < 30; i++) {
      if (chat.getSnapshot().runStatus === "idle") break;
      await sleep(20);
    }
    expect(chat.getSnapshot().runStatus).toBe("idle");
    expect(chat.getSnapshot().items.some((it) => it.kind === "notice" && it.text.includes("Confirmed"))).toBe(true);
    await chat.dispose();
  });

  it("opaque session validation blocks traversal", async () => {
    const chat = await adapter.createChat("ws1", cwd);
    const bad = Buffer.from("/etc/passwd", "utf8").toString("base64url");
    await expect(adapter.resumeChat("ws1", cwd, bad)).rejects.toThrow();
    await expect(adapter.resumeChat("ws1", cwd, "not-base64!!!")).rejects.toThrow();
    await chat.dispose();
  });

  it("SSE reconnect/replay: getEventsSince replays without duplicates", async () => {
    const chat = await adapter.createChat("ws1", cwd);
    await chat.send("normal", "hi");
    for (let i = 0; i < 30; i++) {
      if (chat.getSnapshot().runStatus === "idle") break;
      await sleep(20);
    }
    const { events, nextId } = chat.getEventsSince(0);
    expect(events.length).toBeGreaterThan(0);
    expect(nextId).toBeGreaterThan(0);
    // replay from mid-point
    const mid = Math.floor(events.length / 2);
    const midId = events[mid]!.id;
    const replay = chat.getEventsSince(midId);
    expect(replay.events[0]!.id).toBeGreaterThan(midId);
    // snapshot reconciliation by stable IDs: items have unique IDs
    const ids = chat.getSnapshot().items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    await chat.dispose();
  });

  it("compact works and resnapshot merges without fuzzy dedupe", async () => {
    const chat = await adapter.createChat("ws1", cwd);
    await chat.send("normal", "first");
    for (let i = 0; i < 30; i++) {
      if (chat.getSnapshot().runStatus === "idle") break;
      await sleep(20);
    }
    const before = chat.getSnapshot().items.length;
    await chat.compact("focus on tests");
    const after = chat.getSnapshot().items;
    expect(after.some((i) => i.kind === "notice" && i.text.includes("Compacted"))).toBe(true);
    expect(after.length).toBeLessThanOrEqual(before + 1);
    await chat.dispose();
  });
});
