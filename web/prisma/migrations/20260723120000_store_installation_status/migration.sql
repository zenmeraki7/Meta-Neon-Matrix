DO $$
BEGIN
  CREATE TYPE "StoreInstallationStatus" AS ENUM ('INSTALLED', 'UNINSTALLED', 'SUSPENDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Store"
  ADD COLUMN IF NOT EXISTS "installationStatus" "StoreInstallationStatus";

UPDATE "Store"
SET "installationStatus" = CASE
  WHEN "unInstalledAt" IS NOT NULL OR COALESCE("isUnInstalled", false)
    THEN 'UNINSTALLED'::"StoreInstallationStatus"
  ELSE 'INSTALLED'::"StoreInstallationStatus"
END
WHERE "installationStatus" IS NULL;

ALTER TABLE "Store"
  ALTER COLUMN "installationStatus" SET DEFAULT 'INSTALLED',
  ALTER COLUMN "installationStatus" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "Store_installationStatus_idx"
  ON "Store" ("installationStatus");
