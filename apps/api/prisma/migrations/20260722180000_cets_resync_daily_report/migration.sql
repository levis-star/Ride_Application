-- CeTS: re-submission on detail change, and a durable record of daily reports.
-- NOTE: `prisma migrate diff` also emits `DROP INDEX "Landmark_name_trgm"` —
-- deliberately omitted. That trigram index is raw SQL, absent from
-- schema.prisma, so the diff mistakes it for drift.

-- Fingerprint of the last payload CeTS accepted. LATRA requires re-submission
-- "whenever driver/vehicle details change"; comparing a hash catches every
-- edit path instead of relying on each one to force a re-sync.
-- AlterTable
ALTER TABLE "DriverProfile" ADD COLUMN     "cetsFingerprint" TEXT;

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "cetsFingerprint" TEXT;

-- One row per report date, so we can evidence which days were filed.
-- CreateTable
CREATE TABLE "LatraDailyReport" (
    "id" TEXT NOT NULL,
    "reportDate" TEXT NOT NULL,
    "totalTrip" INTEGER NOT NULL,
    "totalPaidAmount" INTEGER NOT NULL,
    "status" "LatraReportStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LatraDailyReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LatraDailyReport_reportDate_key" ON "LatraDailyReport"("reportDate");

-- CreateIndex
CREATE INDEX "LatraDailyReport_status_idx" ON "LatraDailyReport"("status");
