-- Legacy retirement cleanup: remove obsolete Location.legacy marker.
ALTER TABLE "Location"
  DROP COLUMN IF EXISTS "legacy";
