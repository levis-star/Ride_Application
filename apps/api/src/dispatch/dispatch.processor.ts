import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { appConfig } from "../config/app-config";
import { LocationsService } from "../locations/locations.service";
import { DispatchJob } from "./dispatch-queue.service";
import { DispatchService } from "./dispatch.service";

type MaintenanceJob = { kind: "flush-trip-points" } | { kind: "stale-driver-sweep" };

/**
 * BullMQ workers. All dispatch timing (offer TTL, search retry) and the
 * location maintenance loops (trace flush every 10 s, staleness sweep) run
 * here — server-side, never on clients (spec §6/§7).
 */
@Injectable()
export class DispatchProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatchProcessor.name);
  private connection!: Redis;
  private dispatchWorker!: Worker;
  private maintenanceWorker!: Worker;
  private maintenanceQueue!: Queue;

  constructor(
    private readonly dispatch: DispatchService,
    private readonly locations: LocationsService,
  ) {}

  async onModuleInit() {
    this.connection = new Redis(appConfig.redisUrl, { maxRetriesPerRequest: null });

    this.dispatchWorker = new Worker(
      "dispatch",
      async (job) => {
        const data = job.data as DispatchJob;
        if (data.kind === "search") {
          await this.dispatch.runSearch(data.tripId);
        } else if (data.kind === "offer-timeout") {
          await this.dispatch.onOfferTimeout(data.tripId, data.driverProfileId, data.offerSeq);
        } else if (data.kind === "scheduled-promotion") {
          await this.dispatch.promoteScheduled(data.tripId);
        }
      },
      { connection: this.connection.duplicate(), concurrency: 10, prefix: appConfig.queuePrefix },
    );
    this.dispatchWorker.on("failed", (job, err) => {
      this.logger.error(`dispatch job ${job?.name} ${JSON.stringify(job?.data)} failed: ${err.message}`);
    });

    this.maintenanceQueue = new Queue("maintenance", {
      connection: this.connection,
      prefix: appConfig.queuePrefix,
    });
    this.maintenanceWorker = new Worker(
      "maintenance",
      async (job) => {
        if ((job.data as MaintenanceJob).kind === "flush-trip-points") {
          await this.locations.flushTripPoints();
        } else {
          await this.locations.sweepStaleDrivers();
        }
      },
      { connection: this.connection.duplicate(), concurrency: 2, prefix: appConfig.queuePrefix },
    );
    this.maintenanceWorker.on("failed", (_job, err) => {
      this.logger.error(`maintenance job failed: ${err.message}`);
    });

    await this.maintenanceQueue.upsertJobScheduler(
      "flush-trip-points",
      { every: appConfig.location.flushIntervalMs },
      { name: "flush", data: { kind: "flush-trip-points" } },
    );
    await this.maintenanceQueue.upsertJobScheduler(
      "stale-driver-sweep",
      { every: 15_000 },
      { name: "sweep", data: { kind: "stale-driver-sweep" } },
    );
    this.logger.log("Dispatch + maintenance workers online");
  }

  async onModuleDestroy() {
    await this.dispatchWorker?.close();
    await this.maintenanceWorker?.close();
    await this.maintenanceQueue?.close();
    await this.connection?.quit().catch(() => this.connection.disconnect());
  }
}
