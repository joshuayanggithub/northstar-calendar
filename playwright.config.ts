import { defineConfig, devices } from "@playwright/test";

// Runs the UI in a plain browser against the vite dev server; the frontend
// detects the missing Tauri bridge and uses the mock backend, so these tests
// cover the whole UI layer without the native shell.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:1420",
    trace: "retain-on-failure",
    reducedMotion: "reduce",
    colorScheme: "dark",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // the user runs the real app in light mode; keep both themes pixel-covered
    { name: "light", use: { ...devices["Desktop Chrome"], colorScheme: "light" }, grep: /visual:/ },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: true,
    stdout: "ignore",
  },
});
