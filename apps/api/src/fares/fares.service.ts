import { Injectable, NotFoundException } from "@nestjs/common";
import { FareConfigInput, VehicleClass } from "@rukwaride/shared";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class FaresService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active config for a class, as plain numbers for the pure fare engine. */
  async activeConfig(vehicleClass: VehicleClass): Promise<FareConfigInput> {
    const row = await this.prisma.fareConfig.findFirst({
      where: { vehicleClass, active: true },
      orderBy: { effectiveFrom: "desc" },
    });
    if (!row) throw new NotFoundException(`No active fare config for ${vehicleClass}`);
    return {
      vehicleClass,
      baseFare: Number(row.baseFare),
      perKm: Number(row.perKm),
      perMin: Number(row.perMin),
      bookingFeePct: Number(row.bookingFeePct),
      minimumFare: Number(row.minimumFare),
      commissionPct: Number(row.commissionPct),
      currency: "TZS",
    };
  }
}
