-- CreateEnum
CREATE TYPE "TripKind" AS ENUM ('RIDE', 'PARCEL');

-- CreateEnum
CREATE TYPE "SosStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- AlterEnum
ALTER TYPE "TripStatus" ADD VALUE 'SCHEDULED';

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "kind" "TripKind" NOT NULL DEFAULT 'RIDE',
ADD COLUMN     "packageNote" TEXT,
ADD COLUMN     "recipientName" TEXT,
ADD COLUMN     "recipientPhone" TEXT,
ADD COLUMN     "scheduledAt" TIMESTAMP(3),
ADD COLUMN     "shareToken" TEXT;

-- CreateTable
CREATE TABLE "SosAlert" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "raisedById" TEXT NOT NULL,
    "raisedByRole" "Role" NOT NULL,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "note" TEXT,
    "status" "SosStatus" NOT NULL DEFAULT 'OPEN',
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SosAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SosAlert_status_createdAt_idx" ON "SosAlert"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_shareToken_key" ON "Trip"("shareToken");

-- CreateIndex
CREATE INDEX "Trip_status_scheduledAt_idx" ON "Trip"("status", "scheduledAt");

-- AddForeignKey
ALTER TABLE "SosAlert" ADD CONSTRAINT "SosAlert_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SosAlert" ADD CONSTRAINT "SosAlert_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SosAlert" ADD CONSTRAINT "SosAlert_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
