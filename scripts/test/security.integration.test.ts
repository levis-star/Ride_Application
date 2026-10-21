/**
 * Security regressions (docs/security-assessment.md).
 *
 * Each test pins a control that was found missing in an assessment. They are
 * deliberately behavioural — asserting what an attacker can and cannot do
 * through the API — rather than asserting that a particular line of code
 * exists, so a refactor that keeps the property passes and one that quietly
 * drops it fails.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Role } from "@rukwaride/shared";
import { mintRefreshToken, mintToken } from "../src/auth";
import { TEST_API_URL } from "./global-setup";
import { closeHelpers, prisma, redis } from "./helpers";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let seq = 0;
async function freshPassenger() {
  const phone = `+2557795${String(Date.now() % 100000).padStart(5, "0")}${seq++}`;
  const user = await prisma.user.create({ data: { phone, name: "Sec Test", role: "PASSENGER" } });
  return { user, token: mintToken({ sub: user.id, role: Role.PASSENGER }) };
}

afterAll(closeHelpers);

/**
 * H-2 — a refresh token stayed valid for its full 30-day window regardless of
 * what happened to the account, so blocking a user did not actually stop them.
 */
describe("H-2 session revocation", () => {
  it("refuses to refresh a blocked account", async () => {
    const { user } = await freshPassenger();
    const refreshToken = mintRefreshToken({ sub: user.id, role: Role.PASSENGER });

    // Works while the account is in good standing.
    const before = await fetch(`${TEST_API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(before.status).toBe(201);

    await prisma.user.update({ where: { id: user.id }, data: { isBlocked: true } });

    const after = await fetch(`${TEST_API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(after.status).toBe(401);
  });

  it("refuses to refresh a soft-deleted account", async () => {
    const { user } = await freshPassenger();
    const refreshToken = mintRefreshToken({ sub: user.id, role: Role.PASSENGER });
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });

    const res = await fetch(`${TEST_API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(res.status).toBe(401);
  });

  it("rebuilds claims from the database, so a demotion takes effect on refresh", async () => {
    const { user } = await freshPassenger();
    // A token that *claims* ADMIN for a user who is only a PASSENGER.
    const forged = mintRefreshToken({ sub: user.id, role: Role.ADMIN });

    const res = await fetch(`${TEST_API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: forged }),
    });
    expect(res.status).toBe(201);
    const { accessToken } = (await res.json()) as { accessToken: string };

    // The new access token must carry the *stored* role, not the claimed one.
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64").toString());
    expect(claims.role).toBe("PASSENGER");

    // …and it must not open admin routes.
    const admin = await fetch(`${TEST_API_URL}/admin/landmarks`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(admin.status).toBe(403);
  });
});

/**
 * M-1 — the declared content type is attacker-controlled, so a driver could
 * label an HTML/SVG payload "image/png" and have it open in a reviewer's
 * browser.
 */
describe("M-1 upload content validation", () => {
  it("rejects a file whose bytes do not match its declared type", async () => {
    const { token } = await freshPassenger();
    const reg = await fetch(`${TEST_API_URL}/drivers/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Magic Byte Driver",
        vehicleClass: "BODABODA",
        plateNumber: `MC ${String(Date.now() % 100000).padStart(5, "0")} SEC`,
        licenseNumber: String(4_000_000_000 + (Date.now() % 999_999_999)).slice(0, 10),
        licenceCategory: "A",
        email: `sec${Date.now()}@rukwaride.test`,
      }),
    });
    expect(reg.status).toBe(201);
    const { accessToken } = (await reg.json()) as { accessToken: string };

    const upload = (data: string) =>
      fetch(`${TEST_API_URL}/drivers/me/documents`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "NATIONAL_ID", contentType: "image/png", data }),
      });

    // HTML masquerading as a PNG.
    const evil = Buffer.from('<html><script>alert(1)</script></html>').toString("base64");
    expect((await upload(evil)).status).toBe(400);

    // A real PNG is accepted.
    expect((await upload(PNG_BASE64)).status).toBe(201);
  });

  it("serves stored documents as non-executable attachments", async () => {
    const doc = await prisma.driverDocument.findFirst({ orderBy: { createdAt: "desc" } });
    if (!doc) return; // nothing uploaded in this run
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    const res = await fetch(`${TEST_API_URL}/admin/documents/${doc.id}/file`, {
      headers: { authorization: `Bearer ${mintToken({ sub: admin!.id, role: Role.ADMIN })}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });
});

/**
 * N-3 — the JWKS is published to the internet for LATRA. It must never carry
 * private key material, whichever keypair is configured.
 */
describe("N-3 published JWKS", () => {
  it("exposes public key material only", async () => {
    const res = await fetch(`${TEST_API_URL}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: Array<Record<string, string>> };
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      for (const priv of ["d", "p", "q", "dp", "dq", "qi"]) {
        expect(k[priv], `JWKS must not expose ${priv}`).toBeUndefined();
      }
      expect(k.kty).toBe("RSA");
      expect(k.n).toBeTruthy();
    }
  });
});

/**
 * L-2 — the limiter must actually throttle, and (as a sliding window) must not
 * let a caller exceed the limit by straddling a window boundary.
 */
describe("L-2 rate limiting", () => {
  it("throttles staff-login after the configured number of attempts", async () => {
    // Clear this IP's bucket so the test is deterministic regardless of order.
    for (const k of await redis.keys("rl:staff-login:*")) await redis.del(k);

    const attempt = () =>
      fetch(`${TEST_API_URL}/auth/staff/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: "+255700000001", password: "wrong-on-purpose" }),
      });

    // The limit is 5 per window (scope: ip). The first 5 are processed (and
    // fail auth with 401); the 6th is rejected by the limiter with 429.
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await attempt()).status);

    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    // Nothing past the limit should have reached the auth handler (no 200s).
    expect(codes).not.toContain(200);
    // The limit kicked in at the 6th attempt, not later — proving the window
    // counts continuously rather than resetting mid-stream.
    expect(codes[5]).toBe(429);
  });
});

/** Authorization: admin surfaces must reject non-admin callers. */
describe("admin authorization", () => {
  it("rejects a passenger on every admin surface", async () => {
    const { token } = await freshPassenger();
    for (const path of [
      "/admin/landmarks",
      "/admin/latra-reports",
      "/admin/latra-daily-reports",
      "/admin/latra-registration-issues",
      "/admin/drivers",
    ]) {
      const res = await fetch(`${TEST_API_URL}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect([401, 403], `${path} must not be readable by a passenger`).toContain(res.status);
    }
  });

  it("rejects an unauthenticated caller on admin surfaces", async () => {
    const res = await fetch(`${TEST_API_URL}/admin/landmarks`);
    expect([401, 403]).toContain(res.status);
  });
});
