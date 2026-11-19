import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { E2E } from "./env";

/** Use the system Chrome when present (CI images ship one); otherwise Playwright's own browser. */
const chrome =
  process.env.CHROME_PATH ?? ["/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: E2E.web,
    viewport: { width: 1400, height: 900 },
    launchOptions: chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : {},
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node dist/main.js",
      cwd: "../apps/api",
      url: `${E2E.api}/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        DATABASE_URL: E2E.appUrl,
        PORT: String(E2E.apiPort),
        ASSISTANT_PROVIDER: "mock",
        AUTH_MODE: "dev",
        ...(process.env.AWS_ENDPOINT_URL ? { AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL } : {}),
      },
    },
    {
      command: `pnpm exec next start -p ${E2E.webPort}`,
      cwd: "../apps/web",
      url: E2E.web,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
