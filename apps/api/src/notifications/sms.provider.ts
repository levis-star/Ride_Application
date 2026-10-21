import { Injectable, Logger } from "@nestjs/common";

/**
 * Pluggable SMS provider (spec §4). Selected via SMS_PROVIDER=mock|real.
 * The real adapter is an Africa's Talking-style HTTP scaffold; operator
 * supplies SMS_API_KEY + SMS_SENDER_ID after contracting a TZ-network
 * provider and registering the sender ID with TCRA (spec §20).
 */
export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}

export function maskPhone(phone: string): string {
  return phone.slice(0, 6) + "****" + phone.slice(-2);
}

@Injectable()
export class MockSmsProvider implements SmsProvider {
  private readonly logger = new Logger("MockSms");

  async send(phone: string, message: string): Promise<void> {
    // Phones are masked in logs (spec §14); full delivery is recorded in the
    // Notification table by NotificationsService.
    this.logger.log(`SMS → ${maskPhone(phone)}: ${message}`);
  }
}

@Injectable()
export class HttpSmsProvider implements SmsProvider {
  private readonly logger = new Logger("HttpSms");
  private readonly apiUrl = process.env.SMS_API_URL ?? "";
  private readonly apiKey = process.env.SMS_API_KEY ?? "";
  private readonly senderId = process.env.SMS_SENDER_ID ?? "RUKWARIDE";

  async send(phone: string, message: string): Promise<void> {
    if (!this.apiUrl || !this.apiKey) {
      throw new Error("SMS_PROVIDER=real requires SMS_API_URL and SMS_API_KEY");
    }
    // Africa's Talking-style form POST. TODO-OPERATOR: verify field names and
    // response shape against the contracted provider's docs.
    const res = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        apiKey: this.apiKey,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({ to: phone, from: this.senderId, message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`SMS provider HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    this.logger.log(`SMS sent → ${maskPhone(phone)}`);
  }
}

export const SMS_PROVIDER = "SMS_PROVIDER_TOKEN";
export const FCM_PROVIDER = "FCM_PROVIDER_TOKEN";
