import { Injectable, Logger } from "@nestjs/common";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { appConfig } from "../config/app-config";

/**
 * Pluggable mobile-money aggregator (spec §4/§9): initiate collection push
 * (USSD/STK-style prompt on the payer's phone), disburse to a wallet/phone,
 * verify + parse signed webhooks, and expose a statement for the nightly
 * reconciliation. Selected via PAYMENT_PROVIDER=mock|real.
 */
export interface CollectionRequest {
  phone: string;
  amount: number;
  idempotencyKey: string;
  memo: string;
}

export interface WebhookEvent {
  kind: "collection" | "disbursement";
  providerRef: string;
  status: "SUCCESS" | "FAILED";
  amount: number;
  phone?: string;
  raw: unknown;
}

export interface StatementLine {
  providerRef: string;
  amount: number;
  direction: "IN" | "OUT";
}

export interface PaymentProvider {
  readonly name: string;
  initiateCollection(req: CollectionRequest): Promise<{ providerRef: string }>;
  disburse(req: CollectionRequest): Promise<{ providerRef: string }>;
  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean;
  parseWebhook(payload: unknown): WebhookEvent;
  /** Provider-side statement for a day; [] when the provider can't supply one. */
  fetchStatement(day: Date): Promise<StatementLine[]>;
}

export const PAYMENT_PROVIDER = "PAYMENT_PROVIDER_TOKEN";

export function hmacSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

interface MockWebhookPayload {
  kind: "collection" | "disbursement";
  reference: string;
  result: "SUCCESS" | "FAILED";
  amount: number;
  msisdn?: string;
}

/**
 * Mock aggregator: accepts every initiation and waits for a webhook you send
 * yourself (tests, or `curl` with an HMAC-SHA256 hex signature of the raw
 * body in `x-rukwaride-signature`, secret = PAYMENT_WEBHOOK_SECRET).
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  private readonly logger = new Logger("MockPayment");

  async initiateCollection(req: CollectionRequest): Promise<{ providerRef: string }> {
    const providerRef = `mock-col-${randomUUID()}`;
    this.logger.log(
      `Collection push → ${req.phone.slice(0, 6)}****: TZS ${req.amount} (${req.memo}) ref=${providerRef}`,
    );
    return { providerRef };
  }

  async disburse(req: CollectionRequest): Promise<{ providerRef: string }> {
    const providerRef = `mock-dis-${randomUUID()}`;
    this.logger.log(
      `Disbursement → ${req.phone.slice(0, 6)}****: TZS ${req.amount} (${req.memo}) ref=${providerRef}`,
    );
    return { providerRef };
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    return safeCompare(hmacSignature(rawBody, appConfig.payment.webhookSecret), signature);
  }

  parseWebhook(payload: unknown): WebhookEvent {
    const p = payload as MockWebhookPayload;
    if (!p?.reference || !p.result || !p.kind) throw new Error("Malformed mock webhook payload");
    return {
      kind: p.kind,
      providerRef: p.reference,
      status: p.result,
      amount: Number(p.amount ?? 0),
      phone: p.msisdn,
      raw: payload,
    };
  }

  async fetchStatement(): Promise<StatementLine[]> {
    return []; // the mock has no independent books to compare against
  }
}

/**
 * Real aggregator scaffold (Selcom/AzamPay/ClickPesa-shaped HTTP API).
 * TODO-OPERATOR: contract an aggregator (spec §20), then fill in the exact
 * endpoint paths, auth scheme, and payload field names from their docs and
 * set PAYMENT_PROVIDER=real with PAYMENT_API_URL/KEY/SECRET.
 */
@Injectable()
export class HttpAggregatorProvider implements PaymentProvider {
  readonly name = "real";
  private readonly logger = new Logger("HttpAggregator");

  private ensureConfigured(): void {
    if (!appConfig.payment.apiUrl || !appConfig.payment.apiKey) {
      throw new Error("PAYMENT_PROVIDER=real requires PAYMENT_API_URL and PAYMENT_API_KEY");
    }
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.ensureConfigured();
    const res = await fetch(`${appConfig.payment.apiUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${appConfig.payment.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Aggregator HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async initiateCollection(req: CollectionRequest): Promise<{ providerRef: string }> {
    const json = await this.post("/v1/collections", {
      msisdn: req.phone,
      amount: req.amount,
      currency: "TZS",
      external_id: req.idempotencyKey,
      narration: req.memo,
    });
    return { providerRef: String(json.reference ?? json.transid ?? req.idempotencyKey) };
  }

  async disburse(req: CollectionRequest): Promise<{ providerRef: string }> {
    const json = await this.post("/v1/disbursements", {
      msisdn: req.phone,
      amount: req.amount,
      currency: "TZS",
      external_id: req.idempotencyKey,
      narration: req.memo,
    });
    return { providerRef: String(json.reference ?? json.transid ?? req.idempotencyKey) };
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    return safeCompare(hmacSignature(rawBody, appConfig.payment.webhookSecret), signature);
  }

  parseWebhook(payload: unknown): WebhookEvent {
    // TODO-OPERATOR: map the aggregator's actual webhook fields.
    const p = payload as { kind?: string; reference?: string; result?: string; amount?: number; msisdn?: string };
    if (!p?.reference || !p.result) throw new Error("Malformed aggregator webhook payload");
    return {
      kind: p.kind === "disbursement" ? "disbursement" : "collection",
      providerRef: p.reference,
      status: p.result === "SUCCESS" ? "SUCCESS" : "FAILED",
      amount: Number(p.amount ?? 0),
      phone: p.msisdn,
      raw: payload,
    };
  }

  async fetchStatement(day: Date): Promise<StatementLine[]> {
    this.ensureConfigured();
    this.logger.warn(`fetchStatement(${day.toISOString().slice(0, 10)}) not implemented for this aggregator yet`);
    return [];
  }
}
