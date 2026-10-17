import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PW_PORT ?? "1420");
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("PW_PORT must be an available TCP port number");
}
const serverUrl = `http://127.0.0.1:${port}`;

// Runs the UI in a plain browser against the vite dev server; the frontend
// detects the missing Tauri bridge and uses the mock backend, so these tests
// cover the whole UI layer without the native shell.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: serverUrl,
    trace: "retain-on-failure",
    reducedMotion: "reduce",
    colorScheme: "dark",
    // the suite's times assume Eastern (e.g. "9 AM EDT is 10 PM Tokyo"); pin
    // it so the same assertions hold on any host (the Linux box is Pacific)
    timezoneId: "America/New_York",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // the user runs the real app in light mode; keep both themes pixel-covered
    { name: "light", use: { ...devices["Desktop Chrome"], colorScheme: "light" }, grep: /visual:/ },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    url: serverUrl,
    // Local interactive runs may reuse the developer's Vite server. Automated
    // runs must own it: otherwise a short-lived preview/profile server can be
    // reused and disappear halfway through a long suite.
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
  },
});
