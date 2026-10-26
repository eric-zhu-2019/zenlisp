import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  workers: 1,
  use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 }, baseURL: "http://localhost:1420", screenshot: "only-on-failure", trace: "retain-on-failure" },
  outputDir: "e2e/.results",
  webServer: [
    { command: "node e2e/mock-anthropic.mjs", port: 7899, reuseExistingServer: false },
    {
      command: "cargo run -q -p zenlisp-dev",
      port: 7878,
      reuseExistingServer: false,
      timeout: 300_000,
      // ZENLISP_TRACE=1 shows the Swank traffic, with DEBUG=pw:webserver.
      ...(process.env.ZENLISP_TRACE ? { stdout: "pipe" as const, stderr: "pipe" as const } : {}),
      env: { ...(process.env.ZENLISP_TRACE ? { ZENLISP_TRACE: "1" } : {}), ZENLISP_HYPERSPEC: `${process.cwd()}/e2e/fixtures/hyperspec`,
        // Settings the tests change stay out of the real app's data folder.
        ZENLISP_DATA_DIR: mkdtempSync(join(tmpdir(), "zenlisp-e2e-data-")), ZENLISP_CONFIG_DIR: mkdtempSync(join(tmpdir(), "zenlisp-e2e-config-")), ANTHROPIC_BASE_URL: "http://127.0.0.1:7899", ANTHROPIC_API_KEY: "e2e", OPENAI_BASE_URL: "http://127.0.0.1:7899/v1", OPENAI_API_KEY: "", ZENLISP_DEV_MCP: "1" },
    },
    { command: "npx vite --port 1420 --strictPort", port: 1420, reuseExistingServer: true },
  ],
});
