const { defineConfig, devices } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: ".local/browser-results.json" }]],
  use: {
    baseURL: "http://127.0.0.1:5174",
    launchOptions: process.env.PLAYWRIGHT_CHROME_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH }
      : {},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "phone",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: "npm run dev",
    env: {
      API_PORT: "3104",
      PORT: "3104",
      API_RATE_LIMIT: "2000",
      APP_MODE: "demo",
      WEB_PORT: "5174",
      PHARMACY_MODE: "demo",
      CATALOG_FILE: ":memory:",
    },
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false,
    timeout: 20000,
  },
});
