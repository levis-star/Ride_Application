/**
 * Driver self-onboarding integration tests (spec §12/§13): a passenger
 * registers as a driver (pending), uploads documents into the admin review
 * queue, and can only go online once an admin approves — the full path real
 * drivers will take, exercised against a live API instance.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@rukwaride/shared";
import { mintToken } from "../src/auth";
import { TEST_API_URL } from "./global-setup";
import { closeHelpers, prisma, resetWorld } from "./helpers";

/** 1×1 red PNG — a real image so file round-trips can be byte-compared. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let seq = 0;
/** Fresh OTP-style passenger user (self-provisioned shape) + bearer token. */
async function freshPassenger(): Promise<{ userId: string; phone: string; token: string }> {
  const phone = `+2557790${String(Date.now() % 1_000_000).padStart(6, "0")}${seq++}`;
  const user = await prisma.user.create({ data: { phone, name: "", role: "PASSENGER" } });
  return { userId: user.id, phone, token: mintToken({ sub: user.id, role: Role.PASSENGER }) };
}

const uniquePlate = () => `MC ${String(Date.now() % 100_000).padStart(5, "0")}${seq++} REG`;

async function post(token: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${TEST_API_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}

async function get(token: string, path: string): Promise<Response> {
  return fetch(`${TEST_API_URL}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

async function adminToken(): Promise<string> {
  const res = await fetch(`${TEST_API_URL}/auth/staff/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: "+255700000001", password: "ChangeMe123!" }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** CeTS requires a valid 10-digit licence; unique per call to avoid clashes. */
let licenceSeq = 0;
function uniqueLicence(): string {
  licenceSeq += 1;
  return String(4_000_000_000 + ((Date.now() + licenceSeq) % 999_999_999)).slice(0, 10);
}

/** Register a fresh user as driver; returns the upgraded (DRIVER) token. */
async function registerDriver(vehicleClass = "BODABODA") {
  const p = await freshPassenger();
  const res = await post(p.token, "/drivers/register", {
    name: "Test Driver",
    vehicleClass,
    plateNumber: uniquePlate(),
      licenseNumber: uniqueLicence(),
      licenceCategory: "A",
      email: `d${Date.now()}${Math.random().toString(36).slice(2, 6)}@rukwaride.test`,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    driverProfileId: string;
    vehicle: { plateNumber: string };
  };
  return { ...p, driverToken: body.accessToken, driverProfileId: body.driverProfileId, body };
}

beforeEach(resetWorld);
afterEach(resetWorld);
afterAll(closeHelpers);

describe("driver self-registration", () => {
  it("upgrades a passenger to a pending driver with vehicle + fresh tokens", async () => {
    const reg = await registerDriver();

    const user = await prisma.user.findUnique({
      where: { id: reg.userId },
      include: { driverProfile: { include: { currentVehicle: true } } },
    });
    expect(user?.role).toBe("DRIVER");
    expect(user?.name).toBe("Test Driver");
    expect(user?.driverProfile?.approvedAt).toBeNull();
    expect(user?.driverProfile?.status).toBe("OFFLINE");
    expect(user?.driverProfile?.currentVehicle?.class).toBe("BODABODA");

    // The new token must carry the DRIVER role (old one was PASSENGER-scoped).
    const me = await get(reg.driverToken, "/drivers/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { vehicle: { plateNumber: string } }).vehicle.plateNumber).toBe(
      reg.body.vehicle.plateNumber,
    );
  });

  /**
   * CeTS requires a valid 10-digit licence plus a licence category and email
   * (docs/LATRA 1.pdf §4). A driver missing any of them cannot be registered
   * with LATRA, and a trip may only reference a registered driver — so the
   * trip would be unreportable. Catch it at registration, not at submission.
   */
  it("rejects a registration missing the details LATRA requires", async () => {
    const base = {
      name: "Incomplete Driver",
      vehicleClass: "BODABODA",
      licenseNumber: uniqueLicence(),
      licenceCategory: "A",
      email: "ok@rukwaride.test",
    };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["licence too short", { ...base, licenseNumber: "12345" }],
      ["licence not numeric", { ...base, licenseNumber: "DL-4457-TZ" }],
      ["no licence category", { ...base, licenceCategory: "" }],
      ["no email", { ...base, email: "" }],
      ["malformed email", { ...base, email: "not-an-email" }],
    ];
    for (const [label, body] of cases) {
      const p = await freshPassenger();
      const res = await post(p.token, "/drivers/register", { ...body, plateNumber: uniquePlate() });
      expect(res.status, label).toBe(400);
    }

    // A licence written with spaces/dashes is accepted and normalised.
    const p = await freshPassenger();
    const ok = await post(p.token, "/drivers/register", {
      ...base,
      licenseNumber: "4000-123-454",
      plateNumber: uniquePlate(),
    });
    expect(ok.status).toBe(201);
    const profile = await prisma.driverProfile.findFirst({
      where: { user: { id: p.userId } },
    });
    expect(profile?.licenseNumber).toBe("4000123454");
    expect(profile?.licenceCategory).toBe("A");
  });

  it("rejects double registration and duplicate plates", async () => {
    const reg = await registerDriver();
    const again = await post(reg.driverToken, "/drivers/register", {
      name: "Test Driver",
      vehicleClass: "BODABODA",
      plateNumber: uniquePlate(),
      licenseNumber: uniqueLicence(),
      licenceCategory: "A",
      email: `d${Date.now()}${Math.random().toString(36).slice(2, 6)}@rukwaride.test`,
    });
    expect(again.status).toBe(409);

    const other = await freshPassenger();
    const dupPlate = await post(other.token, "/drivers/register", {
      name: "Other Driver",
      vehicleClass: "BODABODA",
      plateNumber: reg.body.vehicle.plateNumber,
      licenseNumber: uniqueLicence(),
      licenceCategory: "A",
      email: `d${Date.now()}${Math.random().toString(36).slice(2, 6)}@rukwaride.test`,
    });
    expect(dupPlate.status).toBe(409);
  });

  it("refuses staff accounts", async () => {
    const admin = await adminToken();
    const res = await post(admin, "/drivers/register", {
      name: "Admin Sneak",
      vehicleClass: "CAR",
      plateNumber: uniquePlate(),
      licenseNumber: uniqueLicence(),
      licenceCategory: "A",
      email: `d${Date.now()}${Math.random().toString(36).slice(2, 6)}@rukwaride.test`,
    });
    expect([403, 409]).toContain(res.status);
  });
});

describe("document upload → admin review", () => {
  it("uploads into the review queue and the admin can view the file", async () => {
    const reg = await registerDriver();
    const up = await post(reg.driverToken, "/drivers/me/documents", {
      type: "DRIVING_LICENSE",
      contentType: "image/png",
      data: PNG_BASE64,
    });
    expect(up.status).toBe(201);
    const doc = (await up.json()) as { id: string; status: string };
    expect(doc.status).toBe("PENDING_REVIEW");

    const admin = await adminToken();
    const queue = (await (await get(admin, "/admin/documents?status=PENDING_REVIEW")).json()) as {
      id: string;
    }[];
    expect(queue.some((d) => d.id === doc.id)).toBe(true);

    const file = await get(admin, `/admin/documents/${doc.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("image/png");
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);

    // The driver can fetch their own file; another driver cannot.
    const own = await get(reg.driverToken, `/drivers/me/documents/${doc.id}/file`);
    expect(own.status).toBe(200);
    const stranger = await registerDriver();
    const denied = await get(stranger.driverToken, `/drivers/me/documents/${doc.id}/file`);
    expect(denied.status).toBe(404);
  });

  it("rejects disallowed content types", async () => {
    const reg = await registerDriver();
    const res = await post(reg.driverToken, "/drivers/me/documents", {
      type: "DRIVING_LICENSE",
      contentType: "text/html",
      data: Buffer.from("<script>x</script>").toString("base64"),
    });
    expect(res.status).toBe(400);
  });

  it("re-upload after rejection becomes the latest pending document", async () => {
    const reg = await registerDriver();
    const first = (await (
      await post(reg.driverToken, "/drivers/me/documents", {
        type: "NATIONAL_ID",
        contentType: "image/png",
        data: PNG_BASE64,
      })
    ).json()) as { id: string };

    const admin = await adminToken();
    await post(admin, `/admin/documents/${first.id}/review`, {
      decision: "REJECTED",
      rejectionReason: "blurry",
    });

    const second = await post(reg.driverToken, "/drivers/me/documents", {
      type: "NATIONAL_ID",
      contentType: "image/png",
      data: PNG_BASE64,
    });
    expect(second.status).toBe(201);

    const ob = (await (await get(reg.driverToken, "/drivers/me/onboarding")).json()) as {
      documents: { type: string; status: string }[];
    };
    const nid = ob.documents.find((d) => d.type === "NATIONAL_ID");
    expect(nid?.status).toBe("PENDING_REVIEW"); // latest upload wins over the rejected one
  });
});

describe("onboarding checklist + go-online gate", () => {
  it("cannot go online before approval; can after admin approves", async () => {
    const reg = await registerDriver();

    const before = (await (await get(reg.driverToken, "/drivers/me/onboarding")).json()) as {
      canGoOnline: boolean;
      approvedAt: string | null;
      missingDocuments: string[];
    };
    expect(before.canGoOnline).toBe(false);
    expect(before.approvedAt).toBeNull();
    expect(before.missingDocuments.length).toBeGreaterThan(0);

    const online = await post(reg.driverToken, "/drivers/me/status", {
      status: "AVAILABLE",
      lat: -7.9667,
      lng: 31.6167,
    });
    expect(online.status).toBe(403);

    const admin = await adminToken();
    const approve = await post(admin, `/admin/drivers/${reg.driverProfileId}/approve`);
    expect(approve.ok).toBe(true);

    const after = (await (await get(reg.driverToken, "/drivers/me/onboarding")).json()) as {
      canGoOnline: boolean;
      approvedAt: string | null;
    };
    expect(after.approvedAt).not.toBeNull();
    expect(after.canGoOnline).toBe(true);

    const online2 = await post(reg.driverToken, "/drivers/me/status", {
      status: "AVAILABLE",
      lat: -7.9667,
      lng: 31.6167,
    });
    expect(online2.status).toBe(201);
  });
});
