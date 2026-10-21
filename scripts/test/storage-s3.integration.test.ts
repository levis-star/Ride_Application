/**
 * S3 storage driver: boots a dedicated API instance with STORAGE_DRIVER=s3
 * pointed at an in-test fake S3 server, then runs the real driver-document
 * upload/view flow through it. The fake asserts SigV4 request shape and
 * content integrity; true signature acceptance is the operator's sandbox
 * check against the contracted provider (see StorageService header).
 */
import { createHash } from "node:crypto";
import { createServer, Server } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { config as dotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Role } from "@rukwaride/shared";
import { mintToken } from "../src/auth";
import { closeHelpers, prisma } from "./helpers";

const REPO_ROOT = resolve(__dirname, "..", "..");
const API_PORT = 3004;
const API = `http://localhost:${API_PORT}`;
const BUCKET = "test-docs";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** In-memory fake S3: PUT/GET on /<bucket>/<key>, validating request shape. */
const objects = new Map<string, Buffer>();
const authProblems: string[] = [];
let fakeS3: Server;
let apiProcess: ChildProcess | undefined;

function startFakeS3(): Promise<number> {
  fakeS3 = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const path = decodeURIComponent(req.url ?? "");
      const auth = String(req.headers.authorization ?? "");
      const amzSha = String(req.headers["x-amz-content-sha256"] ?? "");

      // SigV4 shape checks — recorded, asserted at the end of the test.
      if (!/^AWS4-HMAC-SHA256 Credential=testkey\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(auth)) {
        authProblems.push(`bad authorization header: ${auth}`);
      }
      if (createHash("sha256").update(body).digest("hex") !== amzSha) {
        authProblems.push(`x-amz-content-sha256 does not match body for ${path}`);
      }
      if (!path.startsWith(`/${BUCKET}/`)) {
        authProblems.push(`path missing bucket prefix: ${path}`);
      }

      if (req.method === "PUT") {
        objects.set(path, body);
        res.writeHead(200).end();
      } else if (req.method === "GET") {
        const found = objects.get(path);
        if (!found) res.writeHead(404).end();
        else res.writeHead(200, { "content-length": found.length }).end(found);
      } else {
        res.writeHead(405).end();
      }
    });
  });
  return new Promise((resolvePort) => {
    fakeS3.listen(0, "127.0.0.1", () => {
      const addr = fakeS3.address();
      resolvePort(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

beforeAll(async () => {
  dotenv({ path: resolve(REPO_ROOT, ".env") });
  const s3Port = await startFakeS3();
  apiProcess = spawn("node", [resolve(REPO_ROOT, "apps/api/dist/main.js")], {
    env: {
      ...process.env,
      API_PORT: String(API_PORT),
      QUEUE_PREFIX: "bull-s3test",
      SOCKET_ADAPTER_KEY: "socket.io-s3test",
      OSRM_URL: "",
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
      S3_BUCKET: BUCKET,
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "testkey",
      S3_SECRET_ACCESS_KEY: "testsecret",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  apiProcess.stderr?.on("data", (d) => process.stderr.write(`[s3-api:err] ${d}`));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${API}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("s3-driver API did not become healthy");
    await new Promise((r) => setTimeout(r, 500));
  }
}, 60_000);

afterAll(async () => {
  apiProcess?.kill("SIGTERM");
  await new Promise<void>((r) => fakeS3.close(() => r()));
  await closeHelpers();
});

describe("s3 storage driver", () => {
  it("driver document upload/view round-trips through the object store", async () => {
    const phone = `+2557730${String(Date.now() % 1_000_000).padStart(6, "0")}`;
    const user = await prisma.user.create({ data: { phone, name: "", role: "PASSENGER" } });
    const passengerToken = mintToken({ sub: user.id, role: Role.PASSENGER });

    const reg = await fetch(`${API}/drivers/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${passengerToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "S3 Driver",
        vehicleClass: "BODABODA",
        plateNumber: `MC ${String(Date.now() % 100_000).padStart(5, "0")} S3T`,
        // CeTS-required driver details (docs/LATRA 1.pdf §4).
        licenseNumber: String(4_000_000_000 + (Date.now() % 999_999_999)).slice(0, 10),
        licenceCategory: "A",
        email: `s3driver${Date.now()}@rukwaride.test`,
      }),
    });
    expect(reg.status).toBe(201);
    const { accessToken } = (await reg.json()) as { accessToken: string };

    const up = await fetch(`${API}/drivers/me/documents`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "DRIVING_LICENSE", contentType: "image/png", data: PNG_BASE64 }),
    });
    expect(up.status).toBe(201);
    const doc = (await up.json()) as { id: string };

    // The object landed in the (fake) bucket under the server-generated key…
    expect(objects.size).toBe(1);
    const [key, stored] = [...objects.entries()][0]!;
    expect(key).toMatch(new RegExp(`^/${BUCKET}/driver-docs/.+/DRIVING_LICENSE-\\d+\\.png$`));
    expect(stored.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);

    // …and reads back byte-identical through the API.
    const file = await fetch(`${API}/drivers/me/documents/${doc.id}/file`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);

    // Every request the API sent was SigV4-shaped with a correct payload hash.
    expect(authProblems).toEqual([]);
  });
});
