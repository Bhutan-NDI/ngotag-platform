-- Non-destructive insert of the did:ethr ledger rows. seed.ts is not run against production (it
-- deleteMany()+recreates the ledgers/ledgerConfig tables, which would break org_agents.ledgerId and
-- schema foreign keys), so rows that only exist in the seed JSON never reach prod. Guarded with
-- WHERE NOT EXISTS since neither table has a unique constraint on the columns being checked, making
-- this safe to run even if a prior seed run already created these rows in a lower environment.

INSERT INTO "ledgers" ("id", "name", "networkType", "poolConfig", "isActive", "networkString", "nymTxnEndpoint", "indyNamespace")
SELECT gen_random_uuid(), 'Ethr Sepolia', 'sepolia', '', true, 'sepolia', '', 'ethr:sepolia'
WHERE NOT EXISTS (SELECT 1 FROM "ledgers" WHERE "indyNamespace" = 'ethr:sepolia');

INSERT INTO "ledgers" ("id", "name", "networkType", "poolConfig", "isActive", "networkString", "nymTxnEndpoint", "indyNamespace")
SELECT gen_random_uuid(), 'Ethr Mainnet', 'mainnet', '', true, 'mainnet', '', 'ethr:mainnet'
WHERE NOT EXISTS (SELECT 1 FROM "ledgers" WHERE "indyNamespace" = 'ethr:mainnet');

INSERT INTO "ledgerConfig" ("id", "name", "details")
SELECT gen_random_uuid(), 'ethereum', '{"did:ethr":{"mainnet":"did:ethr:mainnet","testnet":"did:ethr:sepolia"}}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM "ledgerConfig" WHERE "name" = 'ethereum');
