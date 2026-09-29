-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('RAZORPAY', 'MSG91', 'WHATSAPP_CLOUD', 'SMTP', 'OPENAI');

-- AlterTable
ALTER TABLE "notification_templates" ADD COLUMN     "smsTemplateId" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "gatewayKeyId" TEXT;

-- AlterTable
ALTER TABLE "subscription_plans" ADD COLUMN     "providerPlanIds" JSONB;

-- CreateTable
CREATE TABLE "integration_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "provider" "IntegrationProvider" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_configs_tenantId_provider_key" ON "integration_configs"("tenantId", "provider");

-- Platform rows have tenantId NULL, which the composite unique index does not constrain.
CREATE UNIQUE INDEX "integration_configs_platform_provider_key" ON "integration_configs"("provider") WHERE "tenantId" IS NULL;
