DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='AutomaticProductRule') THEN
    ALTER TABLE "AutomaticProductRule"
      ADD COLUMN IF NOT EXISTS "name" TEXT,
      ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS "commandVersion" INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS "configFingerprint" TEXT,
      ADD COLUMN IF NOT EXISTS "scheduleJson" JSONB,
      ADD COLUMN IF NOT EXISTS "targetMode" TEXT,
      ADD COLUMN IF NOT EXISTS "filterAstJson" JSONB,
      ADD COLUMN IF NOT EXISTS "savedTargetSetId" TEXT,
      ADD COLUMN IF NOT EXISTS "editOperationJson" JSONB,
      ADD COLUMN IF NOT EXISTS "safetyConfirmationJson" JSONB,
      ADD COLUMN IF NOT EXISTS "expectedPreviewFingerprint" TEXT,
      ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "deletedBy" TEXT,
      ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "pausedBy" TEXT,
      ADD COLUMN IF NOT EXISTS "resumedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "resumedBy" TEXT,
      ADD COLUMN IF NOT EXISTS "schedulerDisabledAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "schedulerClaimedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "schedulerClaimId" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='AutomaticProductRuleRun') THEN
    ALTER TABLE "AutomaticProductRuleRun"
      ADD COLUMN IF NOT EXISTS "source" TEXT,
      ADD COLUMN IF NOT EXISTS "ruleRevision" INTEGER,
      ADD COLUMN IF NOT EXISTS "configFingerprint" TEXT,
      ADD COLUMN IF NOT EXISTS "requestedByJson" JSONB,
      ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "cancelledBy" TEXT,
      ADD COLUMN IF NOT EXISTS "cancelReason" TEXT,
      ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='idempotencyKey')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='executionKey') THEN
    EXECUTE 'UPDATE "AutomaticProductRuleRun" SET "idempotencyKey" = COALESCE("idempotencyKey", "executionKey") WHERE "idempotencyKey" IS NULL';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='idempotencyKey') THEN
    EXECUTE 'ALTER TABLE "AutomaticProductRuleRun" ALTER COLUMN "idempotencyKey" SET NOT NULL';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='shop')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='idempotencyKey') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "AutomaticProductRuleRun_shop_idempotencyKey_key" ON "AutomaticProductRuleRun"("shop", "idempotencyKey")';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRule' AND column_name='shop')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRule' AND column_name='deletedAt') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "AutomaticProductRule_shop_deletedAt_idx" ON "AutomaticProductRule"("shop", "deletedAt")';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRule' AND column_name='shop')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRule' AND column_name='status')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRule' AND column_name='deletedAt') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "AutomaticProductRule_shop_status_deletedAt_idx" ON "AutomaticProductRule"("shop", "status", "deletedAt")';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRule' AND column_name='shop')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRule' AND column_name='status')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRule' AND column_name='schedulerDisabledAt') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "AutomaticProductRule_shop_status_schedulerDisabledAt_idx" ON "AutomaticProductRule"("shop", "status", "schedulerDisabledAt")';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRule' AND column_name='status')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRule' AND column_name='nextRunAt') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "AutomaticProductRule_status_nextRunAt_idx" ON "AutomaticProductRule"("status", "nextRunAt")';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='shop')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='automaticProductRuleId')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='status') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "AutomaticProductRuleRun_shop_automaticProductRuleId_status_idx" ON "AutomaticProductRuleRun"("shop", "automaticProductRuleId", "status")';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='shop')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='automaticProductRuleId')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='createdAt') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "AutomaticProductRuleRun_shop_automaticProductRuleId_createdAt_idx" ON "AutomaticProductRuleRun"("shop", "automaticProductRuleId", "createdAt")';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='shop')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomaticProductRuleRun' AND column_name='operationId') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "AutomaticProductRuleRun_shop_operationId_idx" ON "AutomaticProductRuleRun"("shop", "operationId")';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='TargetFreezeCommand')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='TargetFreezeCommand' AND column_name='shop')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='TargetFreezeCommand' AND column_name='operationId') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "TargetFreezeCommand_shop_operationId_idx" ON "TargetFreezeCommand"("shop", "operationId")';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='TargetFreezeCommand')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='TargetFreezeCommand' AND column_name='status')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='TargetFreezeCommand' AND column_name='createdAt') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "TargetFreezeCommand_status_createdAt_idx" ON "TargetFreezeCommand"("status", "createdAt")';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='OutboxEvent')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='OutboxEvent' AND column_name='status')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='OutboxEvent' AND column_name='createdAt') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "OutboxEvent_status_createdAt_idx" ON "OutboxEvent"("status", "createdAt")';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='OutboxEvent')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='OutboxEvent' AND column_name='shop')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='OutboxEvent' AND column_name='aggregateType')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='OutboxEvent' AND column_name='aggregateId') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "OutboxEvent_shop_aggregateType_aggregateId_idx" ON "OutboxEvent"("shop", "aggregateType", "aggregateId")';
  END IF;
END $$;
