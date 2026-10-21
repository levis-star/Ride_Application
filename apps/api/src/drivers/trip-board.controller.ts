import { Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Role } from "@rukwaride/shared";
import { AuthGuard, AuthedRequest, Roles } from "../auth/auth.guard";
import { DispatchService } from "../dispatch/dispatch.service";

/**
 * Driver-claimable searching trips ("Trip Radar", spec-plus): drivers left
 * out of the cascade can still pick up a nearby passenger; the dispatch
 * engine arbitrates all races via the trip state machine + driver locks.
 */
@Controller("drivers")
@UseGuards(AuthGuard)
@Roles(Role.DRIVER)
export class TripBoardController {
  constructor(private readonly dispatch: DispatchService) {}

  @Get("me/trip-board")
  list(@Req() req: AuthedRequest) {
    return this.dispatch.tripBoard(req.user!.driverProfileId!);
  }

  @Post("me/trip-board/:tripId/claim")
  claim(@Req() req: AuthedRequest, @Param("tripId") tripId: string) {
    return this.dispatch.claimTrip(req.user!.driverProfileId!, tripId);
  }
}
