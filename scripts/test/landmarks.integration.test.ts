/**
 * Landmark curation. Our places come from OpenStreetMap, which around
 * Sumbawanga names ATMs after their bank ("NMB Bank") and maps some places
 * twice — a passenger asking for the bank could be routed to a cash machine.
 * Staff with local knowledge correct that here, and those corrections must
 * survive the next import (the demo re-seeds on every launch).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@rukwaride/shared";
import { mintToken } from "../src/auth";
import { TEST_API_URL } from "./global-setup";
import { closeHelpers, prisma } from "./helpers";

let adminToken: string;

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${TEST_API_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  adminToken = mintToken({ sub: admin!.id, role: Role.ADMIN });
  await prisma.landmark.deleteMany({ where: { name: { startsWith: "ZZTest" } } });
});

afterAll(async () => {
  await prisma.landmark.deleteMany({ where: { name: { startsWith: "ZZTest" } } });
  await closeHelpers();
});

describe("landmark curation", () => {
  it("creates a staff landmark that is verified and protected from re-import", async () => {
    const res = await req("POST", "/admin/landmarks", {
      name: "ZZTest NMB Tawi",
      category: "office",
      lat: -7.9654,
      lng: 31.6144,
      aliasNames: ["ZZTest NMB"],
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; source: string; verified: boolean };
    // Staff-entered means locally confirmed: trusted, and off-limits to the importer.
    expect(created.source).toBe("STAFF");
    expect(created.verified).toBe(true);

    const row = await prisma.landmark.findUnique({ where: { id: created.id } });
    expect(row?.verifiedById).toBeTruthy();
    expect(row?.verifiedAt).not.toBeNull();
  });

  it("marks an OSM import as STAFF once edited, so a re-import cannot overwrite it", async () => {
    const osm = await prisma.landmark.create({
      data: { name: "ZZTest NMB Bank", category: "office", lat: -7.96, lng: 31.61, source: "OSM" },
    });
    expect(osm.verified).toBe(false);

    // Correct the name — this is the actual bug: an ATM carrying the bank's name.
    const res = await req("PATCH", `/admin/landmarks/${osm.id}`, {
      name: "ZZTest ATM NMB",
      category: "other",
      verified: true,
    });
    expect(res.status).toBe(200);

    const after = await prisma.landmark.findUnique({ where: { id: osm.id } });
    expect(after?.name).toBe("ZZTest ATM NMB");
    expect(after?.source).toBe("STAFF");
    expect(after?.verified).toBe(true);
  });

  it("reports same-name clusters so duplicates are findable", async () => {
    await prisma.landmark.createMany({
      data: [
        { name: "ZZTest Dup Bank", category: "office", lat: -7.96, lng: 31.61, source: "OSM" },
        { name: "ZZTest Dup Bank", category: "office", lat: -7.97, lng: 31.62, source: "OSM" },
      ],
    });
    const res = await req("GET", "/admin/landmarks/duplicates");
    expect(res.status).toBe(200);
    const groups = (await res.json()) as Array<{ name: string; count: number }>;
    const group = groups.find((g) => g.name === "zztest dup bank");
    expect(group?.count).toBe(2);
  });

  it("merges a duplicate into the surviving landmark, keeping its name as an alias", async () => {
    const keep = await prisma.landmark.create({
      data: { name: "ZZTest Keep Bank", category: "office", lat: -7.96, lng: 31.61, source: "OSM" },
    });
    const drop = await prisma.landmark.create({
      data: { name: "ZZTest Drop Bank", category: "office", lat: -7.9601, lng: 31.6101, source: "OSM" },
    });

    const res = await req("POST", `/admin/landmarks/${drop.id}/merge`, { intoId: keep.id });
    expect(res.status).toBe(201);

    expect(await prisma.landmark.findUnique({ where: { id: drop.id } })).toBeNull();
    const survivor = await prisma.landmark.findUnique({ where: { id: keep.id } });
    // The dropped name is searchable, so people who knew it still find the place.
    expect(survivor?.aliasNames).toContain("ZZTest Drop Bank");
    expect(survivor?.source).toBe("STAFF");
  });

  it("refuses to merge a landmark into itself", async () => {
    const l = await prisma.landmark.create({
      data: { name: "ZZTest Self", category: "other", lat: -7.96, lng: 31.61, source: "OSM" },
    });
    expect((await req("POST", `/admin/landmarks/${l.id}/merge`, { intoId: l.id })).status).toBe(400);
  });

  it("is admin-only", async () => {
    const passenger = await prisma.user.findFirst({ where: { role: "PASSENGER" } });
    const res = await fetch(`${TEST_API_URL}/admin/landmarks`, {
      headers: { authorization: `Bearer ${mintToken({ sub: passenger!.id, role: Role.PASSENGER })}` },
    });
    expect(res.status).toBe(403);
  });
});
