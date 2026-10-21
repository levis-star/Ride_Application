-- CreateTable
CREATE TABLE "NotificationTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sw" TEXT NOT NULL,
    "en" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplate_key_key" ON "NotificationTemplate"("key");

-- Landmark search: trigram index over the Swahili name (spec §11).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Landmark_name_trgm" ON "Landmark" USING GIN ("name" gin_trgm_ops);
