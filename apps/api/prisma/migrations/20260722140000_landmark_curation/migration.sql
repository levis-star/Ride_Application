-- Landmark curation: distinguish crowd-sourced OSM imports from staff-curated
-- places, and record who verified one.
-- NOTE: `prisma migrate diff` also emits `DROP INDEX "Landmark_name_trgm"` —
-- deliberately omitted. That trigram index is created by raw SQL and is not
-- represented in schema.prisma, so the diff mistakes it for drift.

-- AlterTable
ALTER TABLE "Landmark" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'OSM',
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedById" TEXT;

-- AddForeignKey
ALTER TABLE "Landmark" ADD CONSTRAINT "Landmark_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing rows were seeded from OSM but flagged verified=true, which was never
-- true: nobody had checked them, and the flag ranks search results. Reset them
-- so `verified` starts meaning what it says.
UPDATE "Landmark" SET "verified" = false WHERE "source" = 'OSM';
