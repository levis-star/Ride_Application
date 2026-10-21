import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { appConfig } from "../config/app-config";

@Injectable()
export class RedisService implements OnModuleDestroy {
  /** General-purpose client (commands). */
  readonly client: Redis;

  constructor() {
    this.client = new Redis(appConfig.redisUrl, { maxRetriesPerRequest: null });
  }

  duplicate(): Redis {
    return this.client.duplicate();
  }

  async onModuleDestroy() {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
