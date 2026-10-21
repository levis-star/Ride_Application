import { Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Namespace, Socket } from "socket.io";
import { PASSENGER_EVENTS, Role, TripSubscribeSchema } from "@rukwaride/shared";
import { TokenService } from "../auth/jwt.service";
import { PrismaService } from "../prisma/prisma.service";
import { TripsService } from "../trips/trips.service";
import { SocketEmitter } from "./socket-emitter.service";
import { appConfig } from "../config/app-config";

interface PassengerSocket extends Socket {
  data: { userId: string; role: Role };
}

// CORS restricted to our own origins rather than reflecting any origin, so a
// hostile page cannot open a socket in a logged-in user's browser. Native apps
// send no Origin header and are unaffected.
@WebSocketGateway({ namespace: "/passenger", cors: { origin: appConfig.webOrigins, credentials: true } })
export class PassengerGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(PassengerGateway.name);

  @WebSocketServer()
  server!: Namespace;

  constructor(
    private readonly tokens: TokenService,
    private readonly emitter: SocketEmitter,
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
  ) {}

  afterInit(ns: Namespace) {
    this.emitter.registerPassengerNamespace(ns);
  }

  handleConnection(socket: PassengerSocket) {
    try {
      const claims = this.tokens.verify((socket.handshake.auth?.token ?? "") as string);
      socket.data.userId = claims.sub;
      socket.data.role = claims.role;
      void socket.join(SocketEmitter.userRoom(claims.sub));
    } catch {
      this.logger.warn(`Rejected /passenger socket ${socket.id}`);
      socket.disconnect(true);
    }
  }

  @SubscribeMessage(PASSENGER_EVENTS.TRIP_SUBSCRIBE)
  async onSubscribe(@ConnectedSocket() socket: PassengerSocket, @MessageBody() body: unknown) {
    const parsed = TripSubscribeSchema.safeParse(body);
    if (!parsed.success) return { ok: false };
    const trip = await this.prisma.trip.findUnique({ where: { id: parsed.data.tripId } });
    if (!trip) return { ok: false };
    const isStaff = socket.data.role === Role.DISPATCHER || socket.data.role === Role.ADMIN;
    if (!isStaff && trip.passengerId !== socket.data.userId && trip.createdById !== socket.data.userId) {
      return { ok: false };
    }
    await socket.join(SocketEmitter.tripRoom(trip.id));
    // Send the current snapshot immediately so reconnects catch up.
    return { ok: true, trip: await this.trips.snapshot(trip.id) };
  }
}
