-- Restore the trigram index dropped by the payments diff (it lives outside
-- the Prisma schema model, so `migrate diff` keeps trying to remove it).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "Landmark_name_trgm" ON "Landmark" USING GIN ("name" gin_trgm_ops);
