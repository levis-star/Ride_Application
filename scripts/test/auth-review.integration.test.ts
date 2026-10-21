/**
 * App-store review login (Google Play "App access"): allowlisted phones sign
 * in with a fixed OTP while demo mode is OFF — and nothing about the fixed
 * code leaks into the normal login path.
 *
 * The test API runs with AUTH_REVIEW_PHONES=+255770009911 and
 * AUTH_REVIEW_OTP=246810 (see global-setup).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_API_URL } from "./global-setup";
import { closeHelpers, resetWorld } from "./helpers";

const REVIEW_PHONE = "+255770009911";
const REVIEW_OTP = "246810";

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${TEST_API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(resetWorld); // fresh rate-limit buckets — repeated local runs stay green
afterAll(closeHelpers);

describe("app-store review login", () => {
  it("review phone logs in with the fixed code and no demo leak", async () => {
    const req = await post("/auth/otp/request", { phone: REVIEW_PHONE });
    expect(req.status).toBe(201);
    const body = (await req.json()) as { ok: boolean; demoCode?: string };
    expect(body.ok).toBe(true);
    expect(body.demoCode).toBeUndefined(); // demo mode is off — nothing surfaced

    // Wrong code is refused…
    const bad = await post("/auth/otp/verify", { phone: REVIEW_PHONE, code: "111111" });
    expect(bad.status).toBe(401);

    // …the fixed review code works and yields a normal passenger session.
    const ok = await post("/auth/otp/verify", { phone: REVIEW_PHONE, code: REVIEW_OTP });
    expect(ok.status).toBe(201);
    const session = (await ok.json()) as { accessToken: string; role: string };
    expect(session.accessToken).toBeTruthy();
    expect(session.role).toBe("PASSENGER");
  });

  it("the fixed code is useless for any non-allowlisted phone", async () => {
    const phone = `+2557712${String(Date.now() % 100_000).padStart(5, "0")}`;
    const req = await post("/auth/otp/request", { phone });
    expect(req.status).toBe(201);
    const verify = await post("/auth/otp/verify", { phone, code: REVIEW_OTP });
    expect(verify.status).toBe(401); // real random OTP was issued, review code ≠ it
  });

  it("review requests are repeatable (no 1/min resend block for reviewers)", async () => {
    const again = await post("/auth/otp/request", { phone: REVIEW_PHONE });
    expect(again.status).toBe(201);
    const ok = await post("/auth/otp/verify", { phone: REVIEW_PHONE, code: REVIEW_OTP });
    expect(ok.status).toBe(201);
  });
});
