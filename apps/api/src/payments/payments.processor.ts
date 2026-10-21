import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker } from "bullmq";
import Redis from "ioredis";
import { appConfig } from "../config/app-config";
import { LedgerService } from "../ledger/ledger.service";
import { PaymentJob, PaymentsQueueService } from "./payments-queue.service";
import { PaymentsService } from "./payments.service";

@Injectable()
export class PaymentsProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsProcessor.name);
  private connection!: Redis;
  private worker!: Worker;

  constructor(
    private readonly payments: PaymentsService,
    private readonly ledger: LedgerService,
    private readonly queue: PaymentsQueueService,
  ) {}

  async onModuleInit() {
    this.connection = new Redis(appConfig.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      "payments",
      async (job) => {
        const data = job.data as PaymentJob;
        if (data.kind === "process-webhook") {
          await this.payments.processWebhook(data.event);
        } else if (data.kind === "payment-timeout") {
          await this.payments.onPaymentTimeout(data.paymentId);
        } else if (data.kind === "reconciliation") {
          const report = await this.ledger.reconcile();
          this.logger.log(`Reconciliation: ${JSON.stringify(report)}`);
        }
      },
      { connection: this.connection.duplicate(), concurrency: 5, prefix: appConfig.queuePrefix },
    );
    this.worker.on("failed", (job, err) => {
      this.logger.error(`payments job ${job?.name} failed: ${err.message}`);
    });

    // Nightly reconciliation at 03:00 (spec §9/§15 backup window is separate).
    await this.queue.queue.upsertJobScheduler(
      "nightly-reconciliation",
      { pattern: "0 3 * * *" },
      { name: "reconciliation", data: { kind: "reconciliation" } },
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.connection?.quit().catch(() => this.connection.disconnect());
  }
}
