import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { appConfig } from "../config/app-config";
import { WebhookEvent } from "./payment.provider";

export type PaymentJob =
  | { kind: "process-webhook"; event: WebhookEvent }
  | { kind: "payment-timeout"; paymentId: string }
  | { kind: "reconciliation" };

/** Webhooks answer 200 fast; the actual money moves here (spec §9). */
@Injectable()
export class PaymentsQueueService implements OnModuleDestroy {
  private readonly connection = new Redis(appConfig.redisUrl, { maxRetriesPerRequest: null });
  readonly queue = new Queue("payments", { connection: this.connection, prefix: appConfig.queuePrefix });

  async enqueueWebhook(event: WebhookEvent): Promise<void> {
    const job: PaymentJob = { kind: "process-webhook", event };
    await this.queue.add("process-webhook", job, {
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
    });
  }

  async enqueuePaymentTimeout(paymentId: string): Promise<void> {
    const job: PaymentJob = { kind: "payment-timeout", paymentId };
    await this.queue.add("payment-timeout", job, {
      delay: appConfig.payment.timeoutS * 1000,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}
