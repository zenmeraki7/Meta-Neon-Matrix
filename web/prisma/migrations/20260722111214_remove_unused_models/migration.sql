/*
  Warnings:

  - You are about to drop the `AffiliateUser` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AutomaticProductRule` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AutomaticProductRuleProductState` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AutomaticProductRuleRun` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `OperationFingerprint` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ProductCodeSnippet` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ProductTombstone` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ReferralCode` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "AutomaticProductRuleProductState" DROP CONSTRAINT "AutomaticProductRuleProductState_automaticProductRuleId_fkey";

-- DropForeignKey
ALTER TABLE "AutomaticProductRuleRun" DROP CONSTRAINT "AutomaticProductRuleRun_automaticProductRuleId_fkey";

-- DropTable
DROP TABLE "AffiliateUser";

-- DropTable
DROP TABLE "AutomaticProductRule";

-- DropTable
DROP TABLE "AutomaticProductRuleProductState";

-- DropTable
DROP TABLE "AutomaticProductRuleRun";

-- DropTable
DROP TABLE "OperationFingerprint";

-- DropTable
DROP TABLE "ProductCodeSnippet";

-- DropTable
DROP TABLE "ProductTombstone";

-- DropTable
DROP TABLE "ReferralCode";

-- DropEnum
DROP TYPE "AutomaticProductRuleRunStatus";

-- DropEnum
DROP TYPE "AutomaticProductRuleRunTriggerSource";

-- DropEnum
DROP TYPE "AutomaticProductRuleScopeType";

-- DropEnum
DROP TYPE "AutomaticProductRuleStatus";

-- DropEnum
DROP TYPE "AutomaticProductRuleTriggerType";

-- DropEnum
DROP TYPE "AutomaticRuleScheduleType";

-- DropEnum
DROP TYPE "ProductCodeSnippetLanguage";

-- DropEnum
DROP TYPE "ProductCodeSnippetStatus";

-- DropEnum
DROP TYPE "ProductCodeSnippetValidationStatus";
