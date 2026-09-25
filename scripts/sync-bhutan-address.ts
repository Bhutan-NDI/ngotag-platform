/* eslint-disable no-console */
// Rewrites Bhutan's states/cities to the dzongkhag/gewog address master. The seed runs this too;
// use this to preview (--dry-run) or apply it outside a seed run.
//
// Usage: DATABASE_URL=... npx ts-node scripts/sync-bhutan-address.ts [--dry-run]

import { PrismaClient } from '@prisma/client';
import { syncBhutanAddress } from '../libs/prisma-service/prisma/bhutan-address';

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await syncBhutanAddress(prisma, { dryRun: DRY_RUN });
    if (DRY_RUN) {
      console.log('[BHUTAN-ADDRESS] Dry run only — no changes were written.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[BHUTAN-ADDRESS] FAILED:', err.message || err);
  process.exit(1);
});
