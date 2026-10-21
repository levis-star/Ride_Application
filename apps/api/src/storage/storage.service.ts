import { Injectable, Logger } from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * Document/file storage behind one interface (spec §12/§14: private object
 * storage). Two drivers, chosen by env — callers never know the difference:
 *
 *   STORAGE_DRIVER=local  (default) — disk under STORAGE_DIR; demo/dev.
 *   STORAGE_DRIVER=s3     — any S3-compatible store (AWS S3, Cloudflare R2,
 *                           Wasabi, MinIO) via path-style requests + SigV4:
 *       S3_ENDPOINT          e.g. https://<account>.r2.cloudflarestorage.com
 *       S3_BUCKET            private bucket name (never public)
 *       S3_REGION            "auto" for R2, else the bucket region
 *       S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 *
 * OPERATOR: after wiring credentials, upload+view one driver document end to
 * end against the real bucket before launch (sandbox check).
 *
 * Keys are server-generated only (never user input) and content type is
 * carried in the key's extension, so no extra metadata store is needed.
 */
const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/**
 * Leading-byte signatures for the four types we accept. An uploader controls
 * the declared content type, so a document labelled "image/jpeg" could really
 * be HTML or SVG and would then execute when a reviewer opens it. Checking the
 * bytes turns the declaration into something we verified rather than believed.
 */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) =>
    b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  // RIFF....WEBP
  "image/webp": (b) =>
    b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  "application/pdf": (b) => b.length > 4 && b.subarray(0, 5).toString("ascii") === "%PDF-",
};

/** True when the bytes match the declared content type. Unknown types fail. */
export function magicBytesMatch(data: Buffer, contentType: string): boolean {
  const check = MAGIC[contentType];
  return check ? check(data) : false;
}
const TYPE_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_TYPE).map(([t, e]) => [e, t]),
);

export interface StoredFile {
  data: Buffer;
  contentType: string;
}

interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver = process.env.STORAGE_DRIVER ?? "local";
  // dist/storage/ → ../../uploads = apps/api/uploads (persists across restarts)
  private readonly dir = process.env.STORAGE_DIR ?? resolve(__dirname, "..", "..", "uploads");
  private readonly s3?: S3Config;

  constructor() {
    if (this.driver === "s3") {
      const need = (name: string): string => {
        const v = process.env[name];
        if (!v) throw new Error(`STORAGE_DRIVER=s3 requires ${name}`);
        return v;
      };
      this.s3 = {
        endpoint: need("S3_ENDPOINT").replace(/\/+$/, ""),
        bucket: need("S3_BUCKET"),
        region: process.env.S3_REGION ?? "auto",
        accessKeyId: need("S3_ACCESS_KEY_ID"),
        secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
      };
    } else if (this.driver !== "local") {
      throw new Error(`Unknown STORAGE_DRIVER "${this.driver}" — use "local" or "s3"`);
    }
  }

  static extensionFor(contentType: string): string | undefined {
    return EXT_BY_TYPE[contentType];
  }

  private static contentTypeFor(key: string): string {
    const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
    return TYPE_BY_EXT[ext] ?? "application/octet-stream";
  }

  /** Writes bytes under a server-generated key. Returns the key unchanged. */
  async put(key: string, data: Buffer): Promise<string> {
    if (this.s3) {
      const res = await this.s3Request("PUT", key, data);
      if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      return key;
    }
    const path = this.safePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return key;
  }

  async get(key: string): Promise<StoredFile | null> {
    if (this.s3) {
      const res = await this.s3Request("GET", key);
      if (res.status === 404) {
        this.logger.warn(`stored object missing: ${key}`);
        return null;
      }
      if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status}`);
      return { data: Buffer.from(await res.arrayBuffer()), contentType: StorageService.contentTypeFor(key) };
    }
    try {
      const data = await readFile(this.safePath(key));
      return { data, contentType: StorageService.contentTypeFor(key) };
    } catch {
      this.logger.warn(`stored file missing: ${key}`);
      return null;
    }
  }

  // ---------- S3 driver: path-style request signed with AWS SigV4 ----------

  private async s3Request(method: "PUT" | "GET", key: string, body?: Buffer): Promise<Response> {
    const s3 = this.s3!;
    const url = new URL(`${s3.endpoint}/${s3.bucket}/${encodeS3Key(key)}`);
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update(body ?? "").digest("hex");

    // Canonical request (headers must be sorted, lowercase).
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h]}\n`)
      .join("");
    const canonicalRequest = [method, url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

    const scope = `${dateStamp}/${s3.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const hmac = (key: Buffer | string, data: string): Buffer =>
      createHmac("sha256", key).update(data).digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${s3.secretAccessKey}`, dateStamp), s3.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    return fetch(url, {
      method,
      headers: {
        ...headers,
        authorization:
          `AWS4-HMAC-SHA256 Credential=${s3.accessKeyId}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
        ...(body ? { "content-type": "application/octet-stream" } : {}),
      },
      body,
    });
  }

  /** Defense in depth: even server keys must resolve inside the storage root. */
  private safePath(key: string): string {
    const path = resolve(this.dir, key);
    if (!path.startsWith(resolve(this.dir) + sep)) throw new Error(`unsafe storage key: ${key}`);
    return path;
  }
}

/** AWS URI-encoding: encode each path segment, keep the '/' separators. */
function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}
