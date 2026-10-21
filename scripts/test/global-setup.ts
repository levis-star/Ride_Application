/**
 * Boots a dedicated API instance for the integration suite with
 * time-compressed dispatch config (all still server-side timers — only the
 * durations shrink). Requires `pnpm --filter @rukwaride/api build` first and
 * dev docker-compose (Postgres + Redis) running.
 */
import { spawn, ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { config as dotenv } from "dotenv";

const REPO_ROOT = resolve(__dirname, "..", "..");
export const TEST_API_PORT = 3002;
export const TEST_API_URL = `http://localhost:${TEST_API_PORT}`;

/** Dispatch timing used by the suite — import these instead of hardcoding. */
export const TEST_DISPATCH = {
  offerTtlS: 4,
  lockTtlS: 6,
  maxCandidates: 5,
  maxSearchS: 25,
  searchRetryMs: 750,
  staleExcludeS: 5,
};

let apiProcess: ChildProcess | undefined;

export async function setup() {
  dotenv({ path: resolve(REPO_ROOT, ".env") });
  apiProcess = spawn("node", [resolve(REPO_ROOT, "apps/api/dist/main.js")], {
    env: {
      ...process.env,
      API_PORT: String(TEST_API_PORT),
      DISPATCH_OFFER_TTL_S: String(TEST_DISPATCH.offerTtlS),
      DISPATCH_LOCK_TTL_S: String(TEST_DISPATCH.lockTtlS),
      DISPATCH_MAX_CANDIDATES: String(TEST_DISPATCH.maxCandidates),
      DISPATCH_MAX_SEARCH_S: String(TEST_DISPATCH.maxSearchS),
      DISPATCH_SEARCH_RETRY_MS: String(TEST_DISPATCH.searchRetryMs),
      LOCATION_STALE_EXCLUDE_S: String(TEST_DISPATCH.staleExcludeS),
      LOCATION_FLUSH_INTERVAL_MS: "2000",
      // Money-phase timers, compressed for tests (prod default: 120 s).
      PAYMENT_TIMEOUT_S: "3",
      // Isolate this instance from any dev API sharing the same Redis: it
      // must not steal our queue jobs (it runs production timings).
      QUEUE_PREFIX: "bull-test",
      SOCKET_ADAPTER_KEY: "socket.io-test",
      // Deterministic ETAs: road-snapped OSRM durations reorder near-equal
      // candidates run-to-run, breaking exact cascade-order assertions.
      OSRM_URL: "",
      // App-store review login (auth-review suite).
      AUTH_REVIEW_PHONES: "+255770009911",
      AUTH_REVIEW_OTP: "246810",
      // Scheduled-ride promotion lead, compressed so the suite runs fast.
      SCHEDULE_LEAD_S: "1",
      // LATRA report submits after a short delay (captures the post-trip rating).
      LATRA_REPORT_DELAY_S: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProcess.stdout?.on("data", (d) => {
    if (process.env.TEST_API_LOGS) process.stdout.write(`[api] ${d}`);
  });
  apiProcess.stderr?.on("data", (d) => process.stderr.write(`[api:err] ${d}`));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${TEST_API_URL}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("Test API failed to start within 30s");
}

export async function teardown() {
  apiProcess?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  apiProcess?.kill("SIGKILL");
}
