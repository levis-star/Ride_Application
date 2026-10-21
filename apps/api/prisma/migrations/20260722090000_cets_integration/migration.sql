-- CeTS (LATRA Core e-Ticketing System) integration fields.
-- NOTE: `prisma migrate diff` also emits `DROP INDEX "Landmark_name_trgm"` —
-- deliberately omitted. That index is created by raw SQL (trigram search) and
-- is not represented in schema.prisma, so the diff mistakes it for drift.

-- AlterTable
ALTER TABLE "DriverProfile" ADD COLUMN     "cetsLastError" TEXT,
ADD COLUMN     "cetsRegisteredAt" TIMESTAMP(3),
ADD COLUMN     "licenceCategory" TEXT;

-- AlterTable
ALTER TABLE "LatraReport" ADD COLUMN     "latraReferenceNumber" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "email" TEXT,
ADD COLUMN     "nida" TEXT;

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "cetsLastError" TEXT,
ADD COLUMN     "cetsRegisteredAt" TIMESTAMP(3),
ADD COLUMN     "chassisNumber" TEXT,
ADD COLUMN     "registrationDate" TIMESTAMP(3);
