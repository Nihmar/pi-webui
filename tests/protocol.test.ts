import { describe, it, expect } from "vitest";
import { isSafeUrl, truncatePreview, redactSecrets, MAX_TOOL_PREVIEW_CHARS } from "../src/shared/protocol.ts";

describe("URL policy", () => {
  it("allows safe http/https/mailto and relative", () => {
    expect(isSafeUrl("https://example.com")).toBe(true);
    expect(isSafeUrl("http://127.0.0.1:4783")).toBe(true);
    expect(isSafeUrl("mailto:a@b.com")).toBe(true);
    expect(isSafeUrl("/relative")).toBe(true);
    expect(isSafeUrl("#anchor")).toBe(true);
  });
  it("rejects executable/unknown schemes", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeUrl("ftp://example.com")).toBe(false);
  });
});

describe("bounded tool previews", () => {
  it("truncates large output", () => {
    const big = "x".repeat(MAX_TOOL_PREVIEW_CHARS + 500);
    const out = truncatePreview(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_PREVIEW_CHARS + 100);
  });
  it("leaves small output intact", () => {
    expect(truncatePreview("hello")).toBe("hello");
  });
});

describe("secret redaction", () => {
  it("redacts secret keys in objects", () => {
    const input = { api_key: "sk-123", nested: { token: "abc", safe: "hello" } };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.api_key).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).token).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).safe).toBe("hello");
  });
  it("redacts bearer-like strings", () => {
    expect(redactSecrets("Bearer abc123")).toBe("[redacted]");
    expect(redactSecrets("sk-abcdef")).toBe("[redacted]");
  });
  it("truncates very long strings", () => {
    const long = "a".repeat(5000);
    const out = redactSecrets(long) as string;
    expect(out.length).toBeLessThan(long.length);
  });
});
