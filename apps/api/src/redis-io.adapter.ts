import { INestApplication } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { ServerOptions } from "socket.io";
import { appConfig } from "./config/app-config";

/** Socket.io Redis adapter from day one (spec §3: 2+ replicas later, no rework). */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pub?: Redis;
  private sub?: Redis;

  constructor(app: INestApplication) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    this.pub = new Redis(appConfig.redisUrl, { maxRetriesPerRequest: null });
    this.sub = this.pub.duplicate();
    this.adapterConstructor = createAdapter(this.pub, this.sub, { key: appConfig.socketAdapterKey });
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }
}
