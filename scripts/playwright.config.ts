import { defineConfig } from "@playwright/test";

/**
 * E2E (spec §16): drives the real PWA + staff console in Chromium against the
 * live dev stack (API :3001 with production timings, web :3000, docker
 * Postgres/Redis, sim drivers from ./src). Start both servers first —
 * `pnpm e2e` reuses them.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://localhost:3000",
    geolocation: { latitude: -7.9667, longitude: 31.6167 }, // Sumbawanga centre
    permissions: ["geolocation"],
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --env-file=../apps/api/.env ../apps/api/dist/main.js",
      url: "http://localhost:3001/health",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "npx next start -p 3000",
      cwd: "../apps/web",
      url: "http://localhost:3000",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
