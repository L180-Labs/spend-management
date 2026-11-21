-- Sync bookkeeping moves out of the credentials JSON into its own columns, so a
-- sync never has to rewrite "config" (and can't put back credentials that were
-- replaced while it was running).
ALTER TABLE "tool_integrations" ADD COLUMN "configUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "tool_integrations" ADD COLUMN "lastFailedSyncAt" TIMESTAMP(3);
ALTER TABLE "tool_integrations" ADD COLUMN "lastProviderCapUSD" DOUBLE PRECISION;
ALTER TABLE "tool_integrations" ADD COLUMN "providerCapTracked" BOOLEAN NOT NULL DEFAULT false;

-- Drop the keys earlier development builds kept inside config for the same purpose.
UPDATE "tool_integrations" SET "config" = "config" - 'lastProviderCapUSD' - 'lastFailedSyncAt'
WHERE "config" ?| ARRAY['lastProviderCapUSD', 'lastFailedSyncAt'];
