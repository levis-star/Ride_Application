import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { appConfig } from "../config/app-config";

export type DispatchJob =
  | { kind: "search"; tripId: string }
  | { kind: "offer-timeout"; tripId: string; driverProfileId: string; offerSeq: number }
  | { kind: "scheduled-promotion"; tripId: string };

/**
 * Thin handle on the BullMQ dispatch queue. Lives apart from DispatchService
 * so TripsService can enqueue without a module cycle. All dispatch timing is
 * server-side jobs — never client timers (spec §6).
 */
@Injectable()
export class DispatchQueueService implements OnModuleDestroy {
  private readonly connection = new Redis(appConfig.redisUrl, { maxRetriesPerRequest: null });
  readonly queue = new Queue("dispatch", { connection: this.connection, prefix: appConfig.queuePrefix });

  async enqueueSearch(tripId: string, delayMs = 0): Promise<void> {
    const job: DispatchJob = { kind: "search", tripId };
    await this.queue.add("search", job, { delay: delayMs, removeOnComplete: 1000, removeOnFail: 1000 });
  }

  /** Promote a SCHEDULED trip into dispatch at (booked time − lead). */
  async enqueueScheduledPromotion(tripId: string, delayMs: number): Promise<void> {
    const job: DispatchJob = { kind: "scheduled-promotion", tripId };
    await this.queue.add("scheduled-promotion", job, {
      delay: delayMs,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  }

  async enqueueOfferTimeout(
    tripId: string,
    driverProfileId: string,
    offerSeq: number,
    ttlS = appConfig.dispatch.offerTtlS,
  ): Promise<void> {
    const job: DispatchJob = { kind: "offer-timeout", tripId, driverProfileId, offerSeq };
    await this.queue.add("offer-timeout", job, {
      delay: ttlS * 1000,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}
