import { Injectable, Logger } from "@nestjs/common";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Pluggable push provider (spec §4: FCM for driver app + web push).
 * `data` messages must wake the driver app for offers (§7.3).
 */
export interface FcmProvider {
  send(fcmToken: string, notification: { title: string; body: string }, data?: Record<string, string>): Promise<void>;
}

@Injectable()
export class MockFcmProvider implements FcmProvider {
  private readonly logger = new Logger("MockFcm");

  async send(fcmToken: string, notification: { title: string; body: string }, data?: Record<string, string>) {
    this.logger.log(
      `FCM → ${fcmToken.slice(0, 12)}…: ${notification.title} | ${notification.body}` +
        (data ? ` data=${JSON.stringify(data)}` : ""),
    );
  }
}

/**
 * Real adapter: FCM HTTP v1 (https://fcm.googleapis.com/v1).
 *
 * OPERATOR: Firebase console → project settings → service accounts →
 * "generate new private key", then set ONE of
 *   FCM_SERVICE_ACCOUNT_JSON       (the JSON, inline)
 *   FCM_SERVICE_ACCOUNT_JSON_PATH  (path to the JSON file)
 * and PUSH_PROVIDER=fcm. No other change — the send path is complete.
 *
 * Auth is the standard service-account flow: RS256-signed JWT exchanged at
 * Google's token endpoint, access token cached until shortly before expiry.
 */
@Injectable()
export class FcmHttpV1Provider implements FcmProvider {
  private readonly logger = new Logger("FcmHttpV1");
  private readonly creds: { project_id: string; client_email: string; private_key: string };
  private cached?: { token: string; expiresAt: number };

  constructor() {
    const inline = process.env.FCM_SERVICE_ACCOUNT_JSON;
    const path = process.env.FCM_SERVICE_ACCOUNT_JSON_PATH;
    const raw = inline ?? (path ? readFileSync(path, "utf8") : undefined);
    if (!raw) {
      // Fail at boot, not on the first offer in the field.
      throw new Error("PUSH_PROVIDER=fcm but FCM_SERVICE_ACCOUNT_JSON(_PATH) is not set");
    }
    this.creds = JSON.parse(raw) as typeof this.creds;
    if (!this.creds.project_id || !this.creds.client_email || !this.creds.private_key) {
      throw new Error("FCM service account JSON is missing project_id/client_email/private_key");
    }
  }

  private async accessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.token;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned =
      `${b64({ alg: "RS256", typ: "JWT" })}.` +
      b64({
        iss: this.creds.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      });
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.creds.private_key, "base64url");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!res.ok) throw new Error(`FCM token exchange failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
    return json.access_token;
  }

  async send(
    fcmToken: string,
    notification: { title: string; body: string },
    data?: Record<string, string>,
  ): Promise<void> {
    const token = await this.accessToken();
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${this.creds.project_id}/messages:send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token: fcmToken,
            notification,
            data,
            // Offers must surface immediately, screen off or app backgrounded.
            android: { priority: "HIGH" },
          },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      this.logger.warn(`FCM send failed: ${res.status} ${body.slice(0, 300)}`);
      throw new Error(`FCM send failed: ${res.status}`);
    }
  }
}
