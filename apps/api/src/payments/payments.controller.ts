import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { Role } from "@rukwaride/shared";
import { z } from "zod";
import { AuthGuard, AuthedRequest, Roles } from "../auth/auth.guard";
import { RateLimit, RateLimitGuard } from "../auth/rate-limit.guard";
import { LedgerService } from "../ledger/ledger.service";
import { PAYMENT_PROVIDER, PaymentProvider } from "./payment.provider";
import { PaymentsQueueService } from "./payments-queue.service";
import { PaymentsService } from "./payments.service";

const AmountSchema = z.object({ amount: z.number().int().positive() });
const RejectSchema = z.object({ reason: z.string().min(3).max(300) });

@Controller("payments")
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly queue: PaymentsQueueService,
    private readonly ledger: LedgerService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * Aggregator webhook: verify signature against the RAW body, respond 200
   * fast, process via queue (spec §9). Duplicate deliveries are absorbed by
   * the PENDING-only status transition in the worker.
   */
  @Post("webhook")
  @HttpCode(200)
  webhook(@Req() req: FastifyRequest, @Body() body: unknown) {
    const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    const signature = req.headers["x-rukwaride-signature"] as string | undefined;
    if (!rawBody || !this.provider.verifyWebhookSignature(rawBody, signature)) {
      throw new UnauthorizedException("Bad webhook signature");
    }
    let event;
    try {
      event = this.provider.parseWebhook(body);
    } catch (err) {
      throw new BadRequestException(`Unparseable webhook: ${String(err)}`);
    }
    void this.queue.enqueueWebhook(event).catch((e) => this.logger.error(`enqueue failed: ${e}`));
    return { received: true };
  }

  @Post("topup")
  @UseGuards(AuthGuard, RateLimitGuard)
  @Roles(Role.DRIVER)
  @RateLimit({ points: 5, windowS: 300, scope: "user", name: "topup" })
  topup(@Req() req: AuthedRequest, @Body() body: unknown) {
    const { amount } = AmountSchema.parse(body);
    return this.payments.initiateTopUp(req.user!.sub, amount);
  }

  @Post("payouts")
  @UseGuards(AuthGuard)
  @Roles(Role.DRIVER)
  requestPayout(@Req() req: AuthedRequest, @Body() body: unknown) {
    const { amount } = AmountSchema.parse(body);
    return this.payments.requestPayout(req.user!.sub, amount);
  }

  @Get("payouts/mine")
  @UseGuards(AuthGuard)
  @Roles(Role.DRIVER)
  myPayouts(@Req() req: AuthedRequest) {
    return this.payments.listMyPayouts(req.user!.sub);
  }

  @Post("payouts/:id/approve")
  @UseGuards(AuthGuard)
  @Roles(Role.ADMIN)
  approvePayout(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.payments.approvePayout(req.user!.sub, id);
  }

  @Post("payouts/:id/reject")
  @UseGuards(AuthGuard)
  @Roles(Role.ADMIN)
  rejectPayout(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const { reason } = RejectSchema.parse(body);
    return this.payments.rejectPayout(req.user!.sub, id, reason);
  }

  /** On-demand reconciliation (admin screen lands in phase 5; nightly job runs regardless). */
  @Post("admin/reconcile")
  @UseGuards(AuthGuard)
  @Roles(Role.ADMIN)
  reconcile() {
    return this.ledger.reconcile();
  }

  @Get(":id")
  @UseGuards(AuthGuard)
  getPayment(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.payments.getPayment(req.user!.sub, req.user!.driverProfileId, id);
  }
}
