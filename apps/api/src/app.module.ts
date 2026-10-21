import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { SentryGlobalFilter, SentryModule } from "@sentry/nestjs/setup";
import { PrismaService } from "./prisma/prisma.service";
import { RedisService } from "./redis/redis.service";
import { TokenService } from "./auth/jwt.service";
import { AuthGuard } from "./auth/auth.guard";
import { AuthService } from "./auth/auth.service";
import { AuthController } from "./auth/auth.controller";
import { FCM_PROVIDER, HttpSmsProvider, MockSmsProvider, SMS_PROVIDER } from "./notifications/sms.provider";
import { FcmHttpV1Provider, MockFcmProvider } from "./notifications/fcm.provider";
import { NotificationsService } from "./notifications/notifications.service";
import { UsersController } from "./users/users.controller";
import { LandmarksController } from "./landmarks/landmarks.controller";
import { SocketEmitter } from "./gateways/socket-emitter.service";
import { DriverGateway } from "./gateways/driver.gateway";
import { PassengerGateway } from "./gateways/passenger.gateway";
import { DriversService } from "./drivers/drivers.service";
import { DriversController } from "./drivers/drivers.controller";
import { OnboardingController } from "./drivers/onboarding.controller";
import { TripBoardController } from "./drivers/trip-board.controller";
import { OnboardingService } from "./drivers/onboarding.service";
import { StorageService } from "./storage/storage.service";
import { NearbyController } from "./drivers/nearby.controller";
import { LocationsService } from "./locations/locations.service";
import { RoutingService } from "./routing/routing.service";
import { RoutingController } from "./routing/routing.controller";
import { FaresService } from "./fares/fares.service";
import { TripsService } from "./trips/trips.service";
import { TripsController } from "./trips/trips.controller";
import { TripSafetyService } from "./trips/trip-safety.service";
import { PublicController } from "./trips/public.controller";
import { DispatchQueueService } from "./dispatch/dispatch-queue.service";
import { DispatchService } from "./dispatch/dispatch.service";
import { DispatchProcessor } from "./dispatch/dispatch.processor";
import { LedgerService } from "./ledger/ledger.service";
import { HttpAggregatorProvider, MockPaymentProvider, PAYMENT_PROVIDER } from "./payments/payment.provider";
import { PaymentsQueueService } from "./payments/payments-queue.service";
import { PaymentsService } from "./payments/payments.service";
import { PaymentsProcessor } from "./payments/payments.processor";
import { PaymentsController } from "./payments/payments.controller";
import { CetsLatraClient, LATRA_CLIENT, MockLatraClient } from "./latra/latra.client";
import { CetsAuthService } from "./latra/cets-auth.service";
import { CetsDiscoveryController } from "./latra/cets-discovery.controller";
import { LatraService } from "./latra/latra.service";
import { AdminService } from "./admin/admin.service";
import { AdminController } from "./admin/admin.controller";
import { DispatchController } from "./dispatch/dispatch.controller";
import { SupportController } from "./support/support.controller";
import { RateLimitGuard } from "./auth/rate-limit.guard";
import { MetricsService } from "./metrics/metrics.service";
import { MetricsController } from "./metrics/metrics.controller";
import { HealthController } from "./health.controller";

/**
 * Single flat module for the trip-core phase. The spec's domain module split
 * (auth/users/drivers/… as separate Nest modules) is applied as the payments,
 * admin, and LATRA phases land — the file layout already matches it.
 */
@Module({
  imports: [SentryModule.forRoot()],
  controllers: [
    AuthController,
    DriversController,
    OnboardingController,
    TripBoardController,
    TripsController,
    PublicController,
    CetsDiscoveryController,
    NearbyController,
    RoutingController,
    UsersController,
    LandmarksController,
    PaymentsController,
    AdminController,
    DispatchController,
    SupportController,
    MetricsController,
    HealthController,
  ],
  providers: [
    // Reports unhandled 5xx to Sentry (no-op without SENTRY_DSN); specific
    // filters like ZodExceptionFilter still win for their exception types.
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    PrismaService,
    RedisService,
    TokenService,
    AuthGuard,
    AuthService,
    // Pluggable providers (spec §4): mock by default, real adapters when the
    // operator supplies credentials.
    {
      provide: SMS_PROVIDER,
      useClass: process.env.SMS_PROVIDER === "real" ? HttpSmsProvider : MockSmsProvider,
    },
    {
      provide: FCM_PROVIDER,
      useClass: process.env.PUSH_PROVIDER === "fcm" ? FcmHttpV1Provider : MockFcmProvider,
    },
    NotificationsService,
    SocketEmitter,
    DriverGateway,
    PassengerGateway,
    DriversService,
    StorageService,
    OnboardingService,
    LocationsService,
    RoutingService,
    FaresService,
    TripsService,
    TripSafetyService,
    DispatchQueueService,
    DispatchService,
    DispatchProcessor,
    LedgerService,
    {
      provide: PAYMENT_PROVIDER,
      useClass: process.env.PAYMENT_PROVIDER === "real" ? HttpAggregatorProvider : MockPaymentProvider,
    },
    PaymentsQueueService,
    PaymentsService,
    PaymentsProcessor,
    {
      provide: LATRA_CLIENT,
      useClass: process.env.LATRA_CLIENT === "real" ? CetsLatraClient : MockLatraClient,
    },
    CetsAuthService,
    LatraService,
    AdminService,
    RateLimitGuard,
    MetricsService,
  ],
})
export class AppModule {}
