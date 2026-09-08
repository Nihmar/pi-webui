import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4783",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } }
    },
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } }
    }
  ],
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:4783/api/health",
    reuseExistingServer: true,
    timeout: 30_000,
    env: {
      PORT: "4783",
      PI_WEBUI_USE_FAKE: "1",
      WORKSPACE_ROOTS: "/tmp:/home/alessandro"
    }
  }
});
