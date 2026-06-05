-- Enforce at most one *still-live* Marketplace subscription per organization.
--
-- The application-side occupancy check in MarketplaceService.linkOrganization is
-- read-then-write: two concurrent onboarding sessions could each observe no active
-- subscription for the same org and both proceed to link, leaving parallel live
-- subscriptions on one org. This partial unique index is the atomic backstop — the
-- second concurrent link fails with a unique-violation (P2002), which the service
-- maps back to the same ConflictException.
--
-- Cancelled (Unsubscribed) and soft-deleted rows are excluded so the
-- cancel -> re-subscribe -> re-link-the-same-org flow keeps working: only
-- PendingFulfillmentStart / Subscribed / Suspended rows occupy the org.
--
-- NOTE: this filtered unique index cannot be expressed in schema.prisma and is kept
-- as a manual migration. If the table already holds duplicate live subscriptions for
-- a single org, this CREATE will fail — reconcile those rows (set the stale ones to
-- Unsubscribed or soft-delete them) before deploying.
CREATE UNIQUE INDEX "marketplace_subscription_active_org_unique"
    ON "marketplace_subscription" ("orgId")
    WHERE "orgId" IS NOT NULL
      AND "deletedAt" IS NULL
      AND "saasSubscriptionStatus" <> 'Unsubscribed';
