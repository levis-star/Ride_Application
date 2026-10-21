import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AuthGuard, AuthedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";

const TicketSchema = z.object({
  category: z.enum(["FARE_DISPUTE", "DRIVER_CONDUCT", "PASSENGER_CONDUCT", "LOST_ITEM", "APP_ISSUE", "OTHER"]),
  body: z.string().min(5).max(2000),
  tripId: z.string().optional(),
});

@Controller("support")
@UseGuards(AuthGuard)
export class SupportController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("tickets")
  create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const dto = TicketSchema.parse(body);
    return this.prisma.supportTicket.create({
      data: { openedById: req.user!.sub, category: dto.category, body: dto.body, tripId: dto.tripId },
    });
  }

  @Get("tickets/mine")
  mine(@Req() req: AuthedRequest) {
    return this.prisma.supportTicket.findMany({
      where: { openedById: req.user!.sub },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  }
}
