-- Caller name for dispatcher-created trips (no passenger account). Feeds CeTS
-- passengerName so LATRA gets the real caller instead of a placeholder.
ALTER TABLE "Trip" ADD COLUMN "contactName" TEXT;
