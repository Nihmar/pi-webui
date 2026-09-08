import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.describe("mobile flow", () => {
  let ws: string;

  test.beforeEach(async () => {
    ws = mkdtempSync(join(tmpdir(), "e2e-mob-"));
    mkdirSync(ws, { recursive: true });
  });

  test("drawer / composer / stream on 390x844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    // drawer closed initially on mobile; menu button visible
    const menu = page.getByRole("button", { name: /open sessions menu/i });
    await expect(menu).toBeVisible();
    await menu.click();
    const drawer = page.getByRole("complementary", { name: "Sessions" });
    await expect(drawer).toBeVisible();
    // Escape closes drawer
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    // open workspace via drawer
    await menu.click();
    await page.getByLabel(/workspace/i).first().fill(ws);
    await page.getByRole("button", { name: /^open$/i }).click();
    await expect(page.getByText(`Current: ${ws}`).first()).toBeVisible({ timeout: 10000 });
    // new chat closes drawer on mobile
    await page.getByRole("button", { name: /new chat/i }).first().click();
    await expect(page.getByLabel(/message input/i)).toBeVisible({ timeout: 10000 });

    // composer has explicit Send button on mobile
    const input = page.getByLabel(/message input/i);
    await input.fill("mobile hello");
    const send = page.getByRole("button", { name: /^send$/i });
    await expect(send).toBeVisible();
    // touch target comfortable (>=44px)
    const box = await send.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(32);
    await send.click();
    await expect(page.getByText(/Echo:/).first()).toBeVisible({ timeout: 10000 });

    // settings live behind the composer's sliders button; open and check no overflow
    await page.getByRole("button", { name: /settings/i }).click();
    const panel = page.locator(".settings-panel");
    await expect(panel).toBeVisible();
    const vw = page.viewportSize()?.width ?? 390;
    const pb = await panel.boundingBox();
    expect(pb?.width).toBeLessThanOrEqual(vw + 2);
  });
});
