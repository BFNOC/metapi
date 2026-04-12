import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  getModelMappingFromExtraConfig,
  supportsDirectAccountRoutingConnection,
} from './accountExtraConfig.js';

export type TokenModelMappingMigrationSummary = {
  targetAccounts: number;
  migratedAccounts: number;
  failedAccounts: number;
  skippedAccounts: number;
  migratedTokens: number;
  skippedExistingTokens: number;
};

let runMigrationTransaction: typeof db.transaction = db.transaction.bind(db);

export async function migrateAccountModelMappingsToTokens(): Promise<TokenModelMappingMigrationSummary> {
  const summary: TokenModelMappingMigrationSummary = {
    targetAccounts: 0,
    migratedAccounts: 0,
    failedAccounts: 0,
    skippedAccounts: 0,
    migratedTokens: 0,
    skippedExistingTokens: 0,
  };

  const accounts = await db.select().from(schema.accounts).all();
  if (accounts.length === 0) return summary;

  for (const account of accounts) {
    const accountMapping = getModelMappingFromExtraConfig(account.extraConfig);
    if (!accountMapping || supportsDirectAccountRoutingConnection(account)) continue;

    const currentTokens = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    if (currentTokens.length === 0) continue;

    summary.targetAccounts += 1;

    try {
      const result = await runMigrationTransaction(async (tx: any) => {
        const tokens = await tx.select().from(schema.accountTokens)
          .where(eq(schema.accountTokens.accountId, account.id))
          .all();

        let migratedForAccount = 0;
        let skippedExistingForAccount = 0;
        const mappingJson = JSON.stringify(accountMapping);
        const now = new Date().toISOString();

        for (const token of tokens) {
          const existingMapping = typeof token.modelMapping === 'string'
            ? String(token.modelMapping).trim()
            : '';
          if (existingMapping.length > 0) {
            skippedExistingForAccount += 1;
            continue;
          }

          await tx.update(schema.accountTokens)
            .set({
              modelMapping: mappingJson,
              updatedAt: now,
            })
            .where(eq(schema.accountTokens.id, token.id))
            .run();
          migratedForAccount += 1;
        }

        const reloadedTokens = await tx.select().from(schema.accountTokens)
          .where(eq(schema.accountTokens.accountId, account.id))
          .all();
        const validationPassed = reloadedTokens.every((token: any) => {
          const existingMapping = typeof token.modelMapping === 'string'
            ? String(token.modelMapping).trim()
            : '';
          return existingMapping.length > 0;
        });
        if (!validationPassed) {
          throw new Error(`token model mapping validation failed for account ${account.id}`);
        }

        return {
          migratedForAccount,
          skippedExistingForAccount,
          totalTokens: tokens.length,
        };
      });

      summary.migratedTokens += result.migratedForAccount;
      summary.skippedExistingTokens += result.skippedExistingForAccount;

      if (result.migratedForAccount > 0) {
        summary.migratedAccounts += 1;
        console.log(
          `[tokenModelMappingMigration] account ${account.id}: total=${result.totalTokens},`
          + ` migrated=${result.migratedForAccount}, skippedExisting=${result.skippedExistingForAccount}`,
        );
      } else {
        summary.skippedAccounts += 1;
        console.info(
          `[tokenModelMappingMigration] skip account ${account.id}: all ${result.totalTokens} tokens already have token-level modelMapping`,
        );
      }
    } catch (error) {
      summary.failedAccounts += 1;
      console.warn(
        `[tokenModelMappingMigration] failed for account ${account.id}: ${(error as Error)?.message || 'unknown error'}`,
      );
    }
  }
  console.log(
    `[tokenModelMappingMigration] summary: targetAccounts=${summary.targetAccounts},`
    + ` migratedAccounts=${summary.migratedAccounts}, failedAccounts=${summary.failedAccounts},`
    + ` skippedAccounts=${summary.skippedAccounts}, migratedTokens=${summary.migratedTokens},`
    + ` skippedExistingTokens=${summary.skippedExistingTokens}`,
  );
  return summary;
}

export const __tokenModelMappingMigrationTestUtils = {
  setRunMigrationTransactionForTests(fn: typeof db.transaction) {
    runMigrationTransaction = fn;
  },
  resetRunMigrationTransactionForTests() {
    runMigrationTransaction = db.transaction.bind(db);
  },
};
