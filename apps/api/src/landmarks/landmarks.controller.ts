import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Landmark search (spec §11): no geocoding API exists here — destinations are
 * landmarks, pins, GPS, or saved places. Trigram-indexed name search.
 */
@Controller("landmarks")
@UseGuards(AuthGuard)
export class LandmarksController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async search(@Query("q") q?: string) {
    const query = (q ?? "").trim();
    const rows = query
      ? await this.prisma.landmark.findMany({
          where: {
            OR: [
              { name: { contains: query, mode: "insensitive" } },
              { aliasNames: { hasSome: [query] } },
            ],
          },
          orderBy: [{ verified: "desc" }, { name: "asc" }],
          take: 10,
        })
      : await this.prisma.landmark.findMany({ orderBy: [{ verified: "desc" }, { name: "asc" }], take: 15 });
    return rows.map((l) => ({
      id: l.id,
      name: l.name,
      category: l.category,
      lat: Number(l.lat),
      lng: Number(l.lng),
      verified: l.verified,
    }));
  }
}
