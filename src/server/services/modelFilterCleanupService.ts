import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requiresManagedAccountTokens } from './accountExtraConfig.js';

/**
 * Cleanup stale allow-list entries (site-level and token-level) that reference
 * models no longer discovered by any active account/token.
 *
 * Only allow-list entries are cleaned. Deny-list / blacklist entries are
 * intentionally preserved because they represent user safety or cost policies
 * that should survive temporary upstream outages.
 *
 * This function should be called AFTER a successful model refresh pass and
 * BEFORE route rebuild, so that stale allow-list entries do not produce
 * phantom route channels.
 *
 * @param successfulAccountIds – account IDs whose model discovery succeeded
 *   in the current refresh pass.  Only sites/tokens covered by at least one
 *   successful account are eligible for cleanup.  If empty, cleanup is skipped
 *   entirely (avoids misinterpreting a global failure as "all models gone").
 */
export async function cleanupStaleAllowListEntries(successfulAccountIds: number[]): Promise<{
  siteAllowedModelsRemoved: number;
  tokenFilterModelsUpdated: number;
}> {
  if (successfulAccountIds.length === 0) {
    return { siteAllowedModelsRemoved: 0, tokenFilterModelsUpdated: 0 };
  }

  const successSet = new Set(successfulAccountIds);

  // ── Site-level allow-list cleanup ──────────────────────────────────────

  let siteAllowedModelsRemoved = 0;

  // Find sites whose modelFilterMode is 'allow-list'
  const allowListSites = await db.select({
    id: schema.sites.id,
    modelFilterMode: schema.sites.modelFilterMode,
  }).from(schema.sites)
    .where(eq(schema.sites.modelFilterMode, 'allow-list'))
    .all();

  for (const site of allowListSites) {
    // Only clean if at least one active account under this site had a
    // successful refresh — otherwise we can't be sure the models are gone.
    const siteAccounts = await db.select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(
        eq(schema.accounts.siteId, site.id),
        eq(schema.accounts.status, 'active'),
      ))
      .all();

    const hasSuccessfulRefresh = siteAccounts.some((a: { id: number }) => successSet.has(a.id));
    if (!hasSuccessfulRefresh) continue;

    // Build the set of models currently known for this site (auto + manual).
    const siteAccountIds = siteAccounts.map((a: { id: number }) => a.id);
    if (siteAccountIds.length === 0) continue;

    const availabilityRows = await db.select({
      modelName: schema.modelAvailability.modelName,
    }).from(schema.modelAvailability)
      .where(inArray(schema.modelAvailability.accountId, siteAccountIds))
      .all();

    // Also include token-level availability for managed-token platforms
    const tokenAvailabilityRows = await db.select({
      modelName: schema.tokenModelAvailability.modelName,
    }).from(schema.tokenModelAvailability)
      .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .where(inArray(schema.accountTokens.accountId, siteAccountIds))
      .all();

    const knownModels = new Set<string>();
    for (const row of availabilityRows) {
      knownModels.add(row.modelName.toLowerCase());
    }
    for (const row of tokenAvailabilityRows) {
      knownModels.add(row.modelName.toLowerCase());
    }

    // Delete allowed-model entries that are no longer known
    const allowedRows = await db.select()
      .from(schema.siteAllowedModels)
      .where(eq(schema.siteAllowedModels.siteId, site.id))
      .all();

    const staleIds = allowedRows
      .filter((row: { id: number; modelName: string }) => !knownModels.has(row.modelName.toLowerCase()))
      .map((row: { id: number; modelName: string }) => row.id);

    if (staleIds.length > 0) {
      await db.delete(schema.siteAllowedModels)
        .where(inArray(schema.siteAllowedModels.id, staleIds))
        .run();
      siteAllowedModelsRemoved += staleIds.length;
    }
  }

  // ── Token-level allow-list cleanup ─────────────────────────────────────

  let tokenFilterModelsUpdated = 0;

  // Load tokens with allow-list mode and non-empty filteredModels,
  // along with the account info needed to check if it's a managed-token platform.
  const tokenRows = await db.select({
    id: schema.accountTokens.id,
    accountId: schema.accountTokens.accountId,
    modelFilterMode: schema.accountTokens.modelFilterMode,
    filteredModels: schema.accountTokens.filteredModels,
    accessToken: schema.accounts.accessToken,
    apiToken: schema.accounts.apiToken,
    extraConfig: schema.accounts.extraConfig,
  }).from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .where(eq(schema.accountTokens.modelFilterMode, 'allow-list'))
    .all();

  for (const token of tokenRows) {
    // Only clean if the token's account had a successful refresh
    if (!successSet.has(token.accountId)) continue;

    let models: string[];
    try {
      models = JSON.parse(token.filteredModels || '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(models) || models.length === 0) continue;

    const isManaged = requiresManagedAccountTokens({
      accessToken: token.accessToken,
      apiToken: token.apiToken,
      extraConfig: token.extraConfig,
    });

    // For managed-token platforms, only use this token's own discovery data.
    // Account-level modelAvailability may contain models from sibling tokens
    // which this token cannot actually use — including them would keep stale
    // entries alive and produce dead route channels.
    const knownModels = new Set<string>();

    if (isManaged) {
      const tokenAvailability = await db.select({ modelName: schema.tokenModelAvailability.modelName })
        .from(schema.tokenModelAvailability)
        .where(eq(schema.tokenModelAvailability.tokenId, token.id))
        .all();
      for (const row of tokenAvailability) {
        knownModels.add(row.modelName.toLowerCase());
      }
    } else {
      const accountAvailability = await db.select({ modelName: schema.modelAvailability.modelName })
        .from(schema.modelAvailability)
        .where(eq(schema.modelAvailability.accountId, token.accountId))
        .all();
      for (const row of accountAvailability) {
        knownModels.add(row.modelName.toLowerCase());
      }
    }

    const surviving = models.filter((m) => knownModels.has(String(m).toLowerCase()));
    if (surviving.length === models.length) continue;

    await db.update(schema.accountTokens)
      .set({
        filteredModels: JSON.stringify(surviving),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.accountTokens.id, token.id))
      .run();
    tokenFilterModelsUpdated += 1;
  }

  return { siteAllowedModelsRemoved, tokenFilterModelsUpdated };
}
