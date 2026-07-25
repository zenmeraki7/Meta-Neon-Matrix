-- CreateEnum
CREATE TYPE "ProductCodeSnippetStatus" AS ENUM ('ACTIVE', 'DRAFT', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProductCodeSnippetLanguage" AS ENUM ('SNIPPET_DSL');

-- CreateEnum
CREATE TYPE "ProductCodeSnippetValidationStatus" AS ENUM ('VALID', 'INVALID');

-- CreateTable
CREATE TABLE "ProductCodeSnippet" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ProductCodeSnippetStatus" NOT NULL DEFAULT 'DRAFT',
    "language" "ProductCodeSnippetLanguage" NOT NULL DEFAULT 'SNIPPET_DSL',
    "code" TEXT NOT NULL,
    "normalizedAst" JSONB,
    "lastValidationStatus" "ProductCodeSnippetValidationStatus",
    "lastValidationError" TEXT,
    "lastPreviewedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCodeSnippet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateUser" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "referralLink" TEXT NOT NULL,
    "numberOfReferrals" INTEGER NOT NULL DEFAULT 0,
    "numberOfStoresSubscribed" INTEGER NOT NULL DEFAULT 0,
    "totalAmountEarned" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationFingerprint" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductTombstone" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "sourceEventAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "sourceKind" TEXT,
    "lastReconciledAt" TIMESTAMP(3),
    "purgeAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductCodeSnippet_shop_status_idx" ON "ProductCodeSnippet"("shop", "status");

-- CreateIndex
CREATE INDEX "ProductCodeSnippet_shop_createdAt_idx" ON "ProductCodeSnippet"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "ProductCodeSnippet_shop_updatedAt_idx" ON "ProductCodeSnippet"("shop", "updatedAt");

-- CreateIndex
CREATE INDEX "ReferralCode_shop_idx" ON "ReferralCode"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateUser_email_key" ON "AffiliateUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateUser_referralCode_key" ON "AffiliateUser"("referralCode");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateUser_referralLink_key" ON "AffiliateUser"("referralLink");

-- CreateIndex
CREATE INDEX "AffiliateUser_referralCode_idx" ON "AffiliateUser"("referralCode");

-- CreateIndex
CREATE INDEX "OperationFingerprint_resource_idx" ON "OperationFingerprint"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "OperationFingerprint_shop_status_createdAt_idx" ON "OperationFingerprint"("shop", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperationFingerprint_shop_operationType_fingerprint_key" ON "OperationFingerprint"("shop", "operationType", "fingerprint");

-- CreateIndex
CREATE INDEX "ProductTombstone_shop_deletedAt_idx" ON "ProductTombstone"("shop", "deletedAt");

-- CreateIndex
CREATE INDEX "ProductTombstone_shop_purgeAfter_idx" ON "ProductTombstone"("shop", "purgeAfter");

-- CreateIndex
CREATE INDEX "ProductTombstone_shop_updatedAt_idx" ON "ProductTombstone"("shop", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductTombstone_shop_productId_key" ON "ProductTombstone"("shop", "productId");
