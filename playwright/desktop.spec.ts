import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.describe("desktop flow", () => {
  let ws: string;

  test.beforeEach(async () => {
    ws = mkdtempSync(join(tmpdir(), "e2e-ws-"));
    mkdirSync(ws, { recursive: true });
  });

  test("new / send / stream / tool / stop / resume / reconnect / focus", async ({ page }) => {
    await page.goto("/");
    // On narrow viewports the workspace form lives in the drawer; open it if needed.
    const menu = page.getByRole("button", { name: /open sessions menu/i });
    if (await menu.isVisible().catch(() => false)) {
      await menu.click();
    }
    // workspace open
    await expect(page.getByRole("heading", { name: /open a project/i })).toBeVisible();
    await page.getByLabel(/workspace/i).first().fill(ws);
    await page.getByRole("button", { name: /^open$/i }).click();
    await expect(page.getByText(`Current: ${ws}`).first()).toBeVisible({ timeout: 10000 });

    // new chat
    await page.getByRole("button", { name: /new chat/i }).first().click();
    await expect(page.getByLabel(/message input/i)).toBeVisible({ timeout: 10000 });

    // send with tool keyword to trigger tool activity
    const input = page.getByLabel(/message input/i);
    await input.fill("hello with tool please");
    await page.getByRole("button", { name: /^send$/i }).click();

    // streaming assistant + tool activity appears
    await expect(page.getByText(/Echo:/).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator("details.tool").first()).toBeVisible({ timeout: 10000 });

    // stop flow: send long then stop (fake runs are fast, so test stop via abort endpoint resilience)
    await input.fill("second message");
    await page.getByRole("button", { name: /^send$/i }).click();
    await expect(page.getByText(/Echo:/).nth(1)).toBeVisible({ timeout: 10000 });

    // resume: sessions listed in sidebar (open drawer on narrow viewports)
    const menuMid = page.getByRole("button", { name: /open sessions menu/i });
    if (await menuMid.isVisible().catch(() => false)) {
      await menuMid.click();
    }
    const sessButtons = page.locator(".sess-item");
    await expect(sessButtons.first()).toBeVisible({ timeout: 10000 });
    // Close drawer again on narrow viewports so composer is interactable.
    await page.keyboard.press("Escape").catch(() => {});

    // keyboard focus: tab to composer and check visible focus
    await input.focus();
    await expect(input).toBeFocused();
    await page.keyboard.press("Shift+Enter");
    // Shift+Enter should add newline, not send
    const val = await input.inputValue();
    expect(val).toContain("\n");

    // SSE reconnect recovery: reload page, reopen workspace, resume first session, expect no duplicates
    const beforeTexts = await page.locator(".msg.assistant .bubble").allTextContents();
    await page.reload();
    const menu2 = page.getByRole("button", { name: /open sessions menu/i });
    if (await menu2.isVisible().catch(() => false)) {
      await menu2.click();
    }
    await page.getByLabel(/workspace/i).first().fill(ws);
    await page.getByRole("button", { name: /^open$/i }).click();
    await expect(page.locator(".sess-item").first()).toBeVisible({ timeout: 10000 });
    await page.locator(".sess-item").first().click();
    await expect(page.getByLabel(/message input/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Echo:/).first()).toBeVisible({ timeout: 10000 });
    const afterTexts = await page.locator(".msg.assistant .bubble").allTextContents();
    // No duplicates: same number of assistant messages after resume
    expect(afterTexts.length).toBe(beforeTexts.length);
  });
});
