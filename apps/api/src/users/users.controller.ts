import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AuthGuard, AuthedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";

const UpdateMeSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  language: z.enum(["sw", "en"]).optional(),
  fcmToken: z.string().max(4096).nullable().optional(),
});

const SavedPlaceSchema = z.object({
  label: z.string().min(1).max(60),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

@Controller("users")
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("me")
  async me(@Req() req: AuthedRequest) {
    const user = await this.prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user) throw new NotFoundException();
    return { id: user.id, phone: user.phone, name: user.name, role: user.role, language: user.language };
  }

  @Patch("me")
  async updateMe(@Req() req: AuthedRequest, @Body() body: unknown) {
    const dto = UpdateMeSchema.parse(body);
    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.language !== undefined) data.language = dto.language;
    if (dto.fcmToken !== undefined) data.fcmToken = dto.fcmToken;
    const user = await this.prisma.user.update({ where: { id: req.user!.sub }, data });
    return { id: user.id, phone: user.phone, name: user.name, role: user.role, language: user.language };
  }

  @Get("me/places")
  places(@Req() req: AuthedRequest) {
    return this.prisma.savedPlace.findMany({
      where: { userId: req.user!.sub },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, lat: true, lng: true },
    });
  }

  @Post("me/places")
  addPlace(@Req() req: AuthedRequest, @Body() body: unknown) {
    const dto = SavedPlaceSchema.parse(body);
    return this.prisma.savedPlace.create({
      data: { userId: req.user!.sub, ...dto },
      select: { id: true, label: true, lat: true, lng: true },
    });
  }

  @Delete("me/places/:id")
  async deletePlace(@Req() req: AuthedRequest, @Param("id") id: string) {
    await this.prisma.savedPlace.deleteMany({ where: { id, userId: req.user!.sub } });
    return { ok: true };
  }
}
