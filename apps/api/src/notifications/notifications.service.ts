import { Inject, Injectable, Logger } from "@nestjs/common";
import { NotificationChannel, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SocketEmitter } from "../gateways/socket-emitter.service";
import { FCM_PROVIDER, SMS_PROVIDER, SmsProvider } from "./sms.provider";
import { FcmProvider } from "./fcm.provider";

export interface NotifyOptions {
  /** Account holder, if any (dispatcher-created trips may have none). */
  userId?: string | null;
  /** Destination phone; falls back to the user's account phone. */
  phone?: string | null;
  templateKey: string;
  vars?: Record<string, string | number>;
  /**
   * LATRA-required events (driver assigned/arrived, trip started, trip ended
   * + fare): SMS is ALWAYS sent, regardless of socket state (spec §10).
   */
  critical?: boolean;
}

/**
 * Notification pipeline (spec §10). Templates live in the DB (sw/en).
 * Delivery chain per event: socket (state sync — emitted by trip services
 * directly) → FCM push if the user is NOT socket-connected → SMS if there is
 * no push token either. Critical events additionally always get SMS.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private templateCache = new Map<string, { sw: string; en: string; loadedAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: SocketEmitter,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(FCM_PROVIDER) private readonly fcm: FcmProvider,
  ) {}

  /** Fire-and-forget: notification failures must never break a trip flow. */
  notify(opts: NotifyOptions): void {
    void this.deliver(opts).catch((err) =>
      this.logger.error(`notify(${opts.templateKey}) failed: ${String(err)}`),
    );
  }

  /**
   * FCM data push for a trip offer (spec §7.3): wakes the driver app when the
   * socket is down or the app is backgrounded. Fire-and-forget — the socket
   * emit + server-side timeout remain the source of truth.
   */
  pushOfferToDriver(driverProfileId: string, offerJson: string): void {
    void (async () => {
      const profile = await this.prisma.driverProfile.findUnique({
        where: { id: driverProfileId },
        select: { user: { select: { id: true, fcmToken: true } } },
      });
      if (!profile?.user.fcmToken) return;
      const connected = await this.emitter.isUserConnected(profile.user.id, driverProfileId);
      if (connected) return; // socket already delivered it
      await this.fcm.send(
        profile.user.fcmToken,
        { title: "RukwaRide", body: "Safari mpya karibu nawe — fungua app!" },
        { type: "offer:new", payload: offerJson },
      );
    })().catch((err) => this.logger.warn(`offer push to ${driverProfileId} failed: ${String(err)}`));
  }

  /** Awaited SMS (OTP path): caller needs the failure to surface. */
  async sendSmsNow(
    phone: string,
    templateKey: string,
    vars: Record<string, string | number>,
    userId?: string | null,
  ): Promise<void> {
    const message = await this.render(templateKey, "sw", vars);
    if (!message) throw new Error(`No template for key ${templateKey}`);
    const ok = await this.attempt(userId ?? null, NotificationChannel.SMS, templateKey, { phone, message }, () =>
      this.sms.send(phone, message),
    );
    if (!ok) throw new Error(`SMS ${templateKey} delivery failed`);
  }

  private async deliver(opts: NotifyOptions): Promise<void> {
    const user = opts.userId
      ? await this.prisma.user.findUnique({ where: { id: opts.userId }, include: { driverProfile: true } })
      : null;
    const phone = opts.phone ?? user?.phone ?? null;
    const language = user?.language === "en" ? "en" : "sw";
    const message = await this.render(opts.templateKey, language, opts.vars ?? {});
    if (!message) {
      this.logger.error(`No template for key ${opts.templateKey}`);
      return;
    }

    const socketConnected = user
      ? await this.emitter.isUserConnected(user.id, user.driverProfile?.id)
      : false;

    let pushDelivered = false;
    if (user?.fcmToken && (!socketConnected || opts.critical)) {
      pushDelivered = await this.attempt(user.id, NotificationChannel.PUSH, opts.templateKey, { message }, () =>
        this.fcm.send(user.fcmToken!, { title: "RukwaRide", body: message }, { templateKey: opts.templateKey }),
      );
    }

    const smsNeeded = opts.critical || (!socketConnected && !pushDelivered);
    if (smsNeeded && phone) {
      await this.attempt(user?.id ?? null, NotificationChannel.SMS, opts.templateKey, { phone, message }, () =>
        this.sms.send(phone, message),
      );
    }
  }

  private async attempt(
    userId: string | null,
    channel: NotificationChannel,
    templateKey: string,
    payload: Record<string, unknown>,
    send: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await send();
      if (userId) {
        await this.prisma.notification.create({
          data: { userId, channel, templateKey, payload: payload as Prisma.InputJsonValue, sentAt: new Date() },
        });
      }
      return true;
    } catch (err) {
      this.logger.error(`${channel} ${templateKey} failed: ${String(err)}`);
      if (userId) {
        await this.prisma.notification
          .create({
            data: {
              userId,
              channel,
              templateKey,
              payload: payload as Prisma.InputJsonValue,
              failedAt: new Date(),
              error: String(err),
            },
          })
          .catch(() => undefined);
      }
      return false;
    }
  }

  private async render(
    key: string,
    language: "sw" | "en",
    vars: Record<string, string | number>,
  ): Promise<string | null> {
    let tpl = this.templateCache.get(key);
    if (!tpl || Date.now() - tpl.loadedAt > 60_000) {
      const row = await this.prisma.notificationTemplate.findUnique({ where: { key } });
      if (!row) return null;
      tpl = { sw: row.sw, en: row.en, loadedAt: Date.now() };
      this.templateCache.set(key, tpl);
    }
    const text = language === "en" ? tpl.en : tpl.sw;
    return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
  }
}
