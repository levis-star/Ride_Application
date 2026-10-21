import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  LedgerAccount,
  Payment,
  PaymentMethod,
  PaymentStatus,
  PayoutStatus,
  Prisma,
} from "@prisma/client";
import { FareBreakdown } from "@rukwaride/shared";
import { appConfig } from "../config/app-config";
import { PrismaService } from "../prisma/prisma.service";
import { LedgerService } from "../ledger/ledger.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SocketEmitter } from "../gateways/socket-emitter.service";
import { PAYMENT_PROVIDER, PaymentProvider, WebhookEvent } from "./payment.provider";
import { PaymentsQueueService } from "./payments-queue.service";

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly emitter: SocketEmitter,
    private readonly queue: PaymentsQueueService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  // ---------- cash settlement (spec §9: the default path) ----------

  /**
   * Passenger paid the driver directly; the platform books commission +
   * booking fee against the driver wallet as one balanced transaction.
   */
  async recordCashSettlement(tripId: string, driverProfileId: string, breakdown: FareBreakdown): Promise<void> {
    const idempotencyKey = `trip-${tripId}-cash-settlement`;
    const existing = await this.prisma.payment.findUnique({ where: { idempotencyKey } });
    if (existing) return;

    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          tripId,
          driverId: driverProfileId,
          method: PaymentMethod.CASH,
          status: PaymentStatus.CONFIRMED,
          amount: new Prisma.Decimal(breakdown.total),
          idempotencyKey,
        },
      });
      await this.ledger.postWithinTx(tx, [
        {
          account: LedgerAccount.DRIVER_WALLET,
          driverId: driverProfileId,
          debit: breakdown.commission,
          tripId,
          paymentId: payment.id,
          memo: "Commission on cash trip",
        },
        {
          account: LedgerAccount.PLATFORM_REVENUE,
          credit: breakdown.commission,
          tripId,
          paymentId: payment.id,
          memo: "Commission on cash trip",
        },
        {
          account: LedgerAccount.DRIVER_WALLET,
          driverId: driverProfileId,
          debit: breakdown.bookingFee,
          tripId,
          paymentId: payment.id,
          memo: "Booking fee on cash trip",
        },
        {
          account: LedgerAccount.PLATFORM_REVENUE,
          credit: breakdown.bookingFee,
          tripId,
          paymentId: payment.id,
          memo: "Booking fee on cash trip",
        },
      ]);
    });
  }

  // ---------- mobile-money trip payment (spec §9) ----------

  /**
   * On COMPLETED with MOBILE_MONEY: push a collection prompt to the
   * passenger's phone and start the server-side conversion timer. A trip is
   * never left in payment limbo: SUCCESS books the split, FAILED/timeout
   * converts the trip to CASH.
   */
  async initiateTripCollection(tripId: string, driverProfileId: string, breakdown: FareBreakdown): Promise<void> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: { passenger: true },
    });
    if (!trip) return;
    const phone = trip.passenger?.phone ?? trip.contactPhone;
    if (!phone) {
      // No phone to charge — settle as cash immediately.
      await this.convertTripToCash(tripId, "NO_PHONE");
      return;
    }
    const idempotencyKey = `trip-${tripId}-momo`;
    const existing = await this.prisma.payment.findUnique({ where: { idempotencyKey } });
    if (existing) return;

    const payment = await this.prisma.payment.create({
      data: {
        tripId,
        driverId: driverProfileId,
        method: PaymentMethod.MOBILE_MONEY,
        status: PaymentStatus.PENDING,
        amount: new Prisma.Decimal(breakdown.total),
        idempotencyKey,
      },
    });
    try {
      const { providerRef } = await this.provider.initiateCollection({
        phone,
        amount: breakdown.total,
        idempotencyKey,
        memo: `RukwaRide safari ${tripId}`,
      });
      await this.prisma.payment.update({ where: { id: payment.id }, data: { providerRef } });
      await this.queue.enqueuePaymentTimeout(payment.id);
    } catch (err) {
      this.logger.error(`Collection initiation failed for trip ${tripId}: ${String(err)}`);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED },
      });
      await this.convertTripToCash(tripId, "INITIATION_FAILED");
    }
  }

  /** Server-side timer (BullMQ): pending collection expired → CASH. */
  async onPaymentTimeout(paymentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status !== PaymentStatus.PENDING) return;
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.FAILED, providerPayload: { timeout: true } },
    });
    if (payment.tripId) {
      await this.convertTripToCash(payment.tripId, "TIMEOUT");
    }
    this.logger.warn(`Payment ${paymentId} timed out after ${appConfig.payment.timeoutS}s`);
  }

  private async convertTripToCash(tripId: string, reason: string): Promise<void> {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, include: { passenger: true } });
    if (!trip || !trip.driverId || !trip.fareBreakdown) return;
    if (trip.paymentMethod === PaymentMethod.CASH) return; // already converted

    await this.prisma.trip.update({
      where: { id: tripId },
      data: { paymentMethod: PaymentMethod.CASH },
    });
    const breakdown = trip.fareBreakdown as unknown as FareBreakdown;
    await this.recordCashSettlement(tripId, trip.driverId, breakdown);

    // Driver informed in-app; passenger pays cash (spec §9).
    this.emitter.tripUpdateToDriver(trip.driverId, {
      tripId,
      status: "COMPLETED" as never,
      paymentMethod: PaymentMethod.CASH as never,
      finalFare: Number(trip.finalFare ?? trip.estimatedFare),
    });
    const driver = await this.prisma.driverProfile.findUnique({
      where: { id: trip.driverId },
      include: { user: true },
    });
    if (driver) {
      this.notifications.notify({
        userId: driver.userId,
        templateKey: "trip.momo_failed_driver",
        vars: { total: Number(trip.finalFare ?? trip.estimatedFare) },
        critical: false,
      });
    }
    this.notifications.notify({
      userId: trip.passengerId,
      phone: trip.passenger?.phone ?? trip.contactPhone,
      templateKey: "trip.momo_failed_pay_cash",
      vars: { total: Number(trip.finalFare ?? trip.estimatedFare) },
      critical: true, // payment-method change on a live handover — always SMS
    });
    this.logger.warn(`Trip ${tripId} payment converted to CASH (${reason})`);
  }

  // ---------- wallet top-up ----------

  async initiateTopUp(driverUserId: string, amount: number) {
    if (!Number.isInteger(amount) || amount < appConfig.payment.minTopUp) {
      throw new BadRequestException(`Minimum top-up is TZS ${appConfig.payment.minTopUp}`);
    }
    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId: driverUserId },
      include: { user: true },
    });
    if (!profile) throw new NotFoundException("No driver profile");

    const idempotencyKey = `topup-${profile.id}-${Date.now()}`;
    const payment = await this.prisma.payment.create({
      data: {
        driverId: profile.id,
        walletTopUp: true,
        method: PaymentMethod.MOBILE_MONEY,
        status: PaymentStatus.PENDING,
        amount: new Prisma.Decimal(amount),
        idempotencyKey,
      },
    });
    const { providerRef } = await this.provider.initiateCollection({
      phone: profile.user.phone,
      amount,
      idempotencyKey,
      memo: "RukwaRide wallet top-up",
    });
    await this.prisma.payment.update({ where: { id: payment.id }, data: { providerRef } });
    await this.queue.enqueuePaymentTimeout(payment.id);
    return { paymentId: payment.id, providerRef, status: PaymentStatus.PENDING };
  }

  // ---------- webhook processing (worker path) ----------

  async processWebhook(event: WebhookEvent): Promise<void> {
    const payment = await this.prisma.payment.findUnique({ where: { providerRef: event.providerRef } });
    if (!payment) {
      this.logger.warn(`Webhook for unknown providerRef ${event.providerRef} — ignored`);
      return;
    }
    // Duplicate-delivery idempotency: only PENDING payments move.
    if (payment.status !== PaymentStatus.PENDING) return;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { providerPayload: event.raw as Prisma.InputJsonValue },
    });

    if (event.kind === "disbursement") {
      await this.settleDisbursement(payment, event);
      return;
    }
    if (event.status === "FAILED") {
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.FAILED } });
      if (payment.tripId) await this.convertTripToCash(payment.tripId, "PROVIDER_FAILED");
      return;
    }

    if (payment.walletTopUp && payment.driverId) {
      // DEBIT AGGREGATOR_CLEARING / CREDIT DRIVER_WALLET (spec §9).
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.CONFIRMED } });
        await this.ledger.postWithinTx(tx, [
          {
            account: LedgerAccount.AGGREGATOR_CLEARING,
            debit: Number(payment.amount),
            paymentId: payment.id,
            memo: "Wallet top-up collection",
          },
          {
            account: LedgerAccount.DRIVER_WALLET,
            driverId: payment.driverId!,
            credit: Number(payment.amount),
            paymentId: payment.id,
            memo: "Wallet top-up",
          },
        ]);
      });
      const driver = await this.prisma.driverProfile.findUnique({ where: { id: payment.driverId } });
      if (driver) {
        this.notifications.notify({
          userId: driver.userId,
          templateKey: "payment.topup_ok",
          vars: { amount: Number(payment.amount) },
          critical: false,
        });
      }
      this.logger.log(`Top-up ${payment.id} confirmed: TZS ${payment.amount}`);
      return;
    }

    if (payment.tripId && payment.driverId) {
      const trip = await this.prisma.trip.findUnique({ where: { id: payment.tripId } });
      const breakdown = trip?.fareBreakdown as unknown as FareBreakdown | null;
      if (!breakdown) {
        this.logger.error(`Trip ${payment.tripId} missing fareBreakdown — cannot settle momo payment`);
        return;
      }
      // CREDIT driver earnings + platform fees vs DEBIT clearing (spec §9).
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.CONFIRMED } });
        await this.ledger.postWithinTx(tx, [
          {
            account: LedgerAccount.AGGREGATOR_CLEARING,
            debit: breakdown.total,
            tripId: payment.tripId!,
            paymentId: payment.id,
            memo: "Mobile-money trip collection",
          },
          {
            account: LedgerAccount.DRIVER_WALLET,
            driverId: payment.driverId!,
            credit: breakdown.driverEarnings,
            tripId: payment.tripId!,
            paymentId: payment.id,
            memo: "Driver earnings (mobile money trip)",
          },
          {
            account: LedgerAccount.PLATFORM_REVENUE,
            credit: breakdown.commission + breakdown.bookingFee,
            tripId: payment.tripId!,
            paymentId: payment.id,
            memo: "Commission + booking fee (mobile money trip)",
          },
        ]);
      });
      this.logger.log(`Mobile-money trip ${payment.tripId} settled: TZS ${breakdown.total}`);
    }
  }

  private async settleDisbursement(payment: Payment, event: WebhookEvent): Promise<void> {
    const payout = await this.prisma.payoutRequest.findUnique({ where: { paymentId: payment.id } });
    if (event.status === "SUCCESS") {
      await this.prisma.$transaction([
        this.prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.CONFIRMED } }),
        ...(payout
          ? [this.prisma.payoutRequest.update({ where: { id: payout.id }, data: { status: PayoutStatus.PAID } })]
          : []),
      ]);
      return;
    }
    // Disbursement failed after we reserved the money — reverse the reservation.
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.FAILED } });
      if (payout) {
        await tx.payoutRequest.update({ where: { id: payout.id }, data: { status: PayoutStatus.FAILED } });
      }
      await this.ledger.postWithinTx(tx, [
        {
          account: LedgerAccount.DRIVER_WALLET,
          driverId: payment.driverId!,
          credit: Number(payment.amount),
          paymentId: payment.id,
          memo: "Payout reversal (disbursement failed)",
        },
        {
          account: LedgerAccount.AGGREGATOR_CLEARING,
          debit: Number(payment.amount),
          paymentId: payment.id,
          memo: "Payout reversal (disbursement failed)",
        },
      ]);
    });
    this.logger.warn(`Payout ${payout?.id ?? payment.id} failed — wallet refunded`);
  }

  // ---------- payouts (admin-approved, never automatic — spec §9) ----------

  async requestPayout(driverUserId: string, amount: number) {
    const profile = await this.prisma.driverProfile.findUnique({ where: { userId: driverUserId } });
    if (!profile) throw new NotFoundException("No driver profile");
    if (!Number.isInteger(amount) || amount < 1000) throw new BadRequestException("Minimum payout is TZS 1000");
    if (Number(profile.walletBalance) < amount) {
      throw new BadRequestException("Amount exceeds wallet balance");
    }
    const open = await this.prisma.payoutRequest.count({
      where: { driverId: profile.id, status: { in: [PayoutStatus.REQUESTED, PayoutStatus.APPROVED] } },
    });
    if (open > 0) throw new BadRequestException("A payout request is already open");
    return this.prisma.payoutRequest.create({
      data: { driverId: profile.id, amount: new Prisma.Decimal(amount) },
    });
  }

  async listMyPayouts(driverUserId: string) {
    const profile = await this.prisma.driverProfile.findUnique({ where: { userId: driverUserId } });
    if (!profile) throw new NotFoundException("No driver profile");
    return this.prisma.payoutRequest.findMany({
      where: { driverId: profile.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  }

  async approvePayout(adminUserId: string, payoutId: string) {
    const payout = await this.prisma.payoutRequest.findUnique({
      where: { id: payoutId },
      include: { driver: { include: { user: true } } },
    });
    if (!payout) throw new NotFoundException("Payout request not found");
    if (payout.status !== PayoutStatus.REQUESTED) {
      throw new BadRequestException(`Payout is ${payout.status}, not REQUESTED`);
    }
    const amount = Number(payout.amount);
    if (Number(payout.driver.walletBalance) < amount) {
      throw new BadRequestException("Driver wallet no longer covers the payout");
    }

    // Reserve the money first (balanced txn), then instruct the aggregator.
    const idempotencyKey = `payout-${payout.id}`;
    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          driverId: payout.driverId,
          method: PaymentMethod.MOBILE_MONEY,
          status: PaymentStatus.PENDING,
          amount: payout.amount,
          idempotencyKey,
        },
      });
      await this.ledger.postWithinTx(tx, [
        {
          account: LedgerAccount.DRIVER_WALLET,
          driverId: payout.driverId,
          debit: amount,
          paymentId: p.id,
          memo: "Payout to driver (reserved)",
        },
        {
          account: LedgerAccount.AGGREGATOR_CLEARING,
          credit: amount,
          paymentId: p.id,
          memo: "Payout to driver (reserved)",
        },
      ]);
      await tx.payoutRequest.update({
        where: { id: payout.id },
        data: { status: PayoutStatus.APPROVED, approvedById: adminUserId, paymentId: p.id },
      });
      await tx.auditLog.create({
        data: {
          actorId: adminUserId,
          action: "PAYOUT_APPROVED",
          entity: "PayoutRequest",
          entityId: payout.id,
          after: { amount },
        },
      });
      return p;
    });

    try {
      const { providerRef } = await this.provider.disburse({
        phone: payout.driver.user.phone,
        amount,
        idempotencyKey,
        memo: "RukwaRide payout",
      });
      await this.prisma.payment.update({ where: { id: payment.id }, data: { providerRef } });
    } catch (err) {
      // Disburse call itself failed — reverse the reservation immediately.
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.FAILED } });
        await tx.payoutRequest.update({ where: { id: payout.id }, data: { status: PayoutStatus.FAILED } });
        await this.ledger.postWithinTx(tx, [
          {
            account: LedgerAccount.DRIVER_WALLET,
            driverId: payout.driverId,
            credit: amount,
            paymentId: payment.id,
            memo: "Payout reversal (disburse call failed)",
          },
          {
            account: LedgerAccount.AGGREGATOR_CLEARING,
            debit: amount,
            paymentId: payment.id,
            memo: "Payout reversal (disburse call failed)",
          },
        ]);
      });
      throw new BadRequestException(`Disbursement failed: ${String(err)}`);
    }
    return { payoutId: payout.id, status: PayoutStatus.APPROVED, paymentId: payment.id };
  }

  async rejectPayout(adminUserId: string, payoutId: string, reason: string) {
    const payout = await this.prisma.payoutRequest.findUnique({ where: { id: payoutId } });
    if (!payout) throw new NotFoundException("Payout request not found");
    if (payout.status !== PayoutStatus.REQUESTED) {
      throw new BadRequestException(`Payout is ${payout.status}, not REQUESTED`);
    }
    await this.prisma.$transaction([
      this.prisma.payoutRequest.update({
        where: { id: payoutId },
        data: { status: PayoutStatus.REJECTED, approvedById: adminUserId, rejectReason: reason },
      }),
      this.prisma.auditLog.create({
        data: {
          actorId: adminUserId,
          action: "PAYOUT_REJECTED",
          entity: "PayoutRequest",
          entityId: payoutId,
          after: { reason },
        },
      }),
    ]);
    return { ok: true };
  }

  async getPayment(userId: string, driverProfileId: string | undefined, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException("Payment not found");
    if (payment.driverId && payment.driverId !== driverProfileId) {
      throw new ForbiddenException("Not your payment");
    }
    return {
      id: payment.id,
      status: payment.status,
      amount: Number(payment.amount),
      method: payment.method,
      walletTopUp: payment.walletTopUp,
      tripId: payment.tripId,
      createdAt: payment.createdAt,
    };
  }
}
