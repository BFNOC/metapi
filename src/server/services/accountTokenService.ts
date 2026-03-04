import { and, eq, ne } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

type UpstreamApiToken = {
  name?: string | null;
  key?: string | null;
  enabled?: boolean | null;
  tokenGroup?: string | null;
};

export function normalizeTokenForDisplay(token?: string | null, platform?: string | null): string {
  if (!token) return '';
  const value = token.trim();
  if (!value) return '';
  if (platform !== undefined) {
    // Keep the parameter for route-level compatibility; display rule is now global.
  }
  if (!value.toLowerCase().startsWith('sk-')) {
    return `sk-${value}`;
  }
  return value;
}

export function maskToken(token?: string | null, platform?: string | null): string {
  const value = normalizeTokenForDisplay(token, platform);
  if (!value) return '';
  if (value.toLowerCase().startsWith('sk-')) {
    if (value.length <= 7) return 'sk-***';
    const visibleMiddle = value.slice(3, Math.min(6, value.length));
    if (value.length <= 12) return `sk-${visibleMiddle}***${value.slice(-2)}`;
    return `sk-${visibleMiddle}***${value.slice(-4)}`;
  }
  if (value.length <= 10) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function normalizeTokenName(name: string | null | undefined, fallbackIndex = 1): string {
  const trimmed = (name || '').trim();
  if (trimmed) return trimmed;
  return fallbackIndex === 1 ? 'default' : `token-${fallbackIndex}`;
}

function normalizeTokenValue(token: string | null | undefined): string | null {
  const trimmed = (token || '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTokenGroup(value: string | null | undefined, tokenName?: string | null): string | null {
  const explicit = (value || '').trim();
  if (explicit.length > 0) return explicit;

  const name = (tokenName || '').trim();
  if (!name) return null;
  const normalized = name.toLowerCase();
  if (normalized === 'default' || normalized === '默认' || /^default($|[-_\s])/.test(normalized)) {
    return 'default';
  }
  if (/^token-\d+$/.test(normalized)) return null;
  return name;
}

function updateAccountApiToken(accountId: number, tokenValue: string | null) {
  db.update(schema.accounts)
    .set({ apiToken: tokenValue || null, updatedAt: new Date().toISOString() })
    .where(eq(schema.accounts.id, accountId))
    .run();
}

export function getPreferredAccountToken(accountId: number) {
  const tokens = db.select()
    .from(schema.accountTokens)
    .where(and(eq(schema.accountTokens.accountId, accountId), eq(schema.accountTokens.enabled, true)))
    .all();

  if (tokens.length === 0) return null;

  const preferred = tokens.find((t) => t.isDefault) || tokens[0];
  return preferred;
}

export function ensureDefaultTokenForAccount(
  accountId: number,
  tokenValue: string,
  options?: { name?: string; source?: string; enabled?: boolean; tokenGroup?: string | null },
): number | null {
  const normalizedToken = normalizeTokenValue(tokenValue);
  if (!normalizedToken) return null;
  const tokenGroup = normalizeTokenGroup(options?.tokenGroup, options?.name) || 'default';

  const now = new Date().toISOString();
  const tokens = db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  let target = tokens.find((t) => t.token === normalizedToken) || null;
  if (!target) {
    target = db.insert(schema.accountTokens)
      .values({
        accountId,
        name: normalizeTokenName(options?.name, tokens.length + 1),
        token: normalizedToken,
        tokenGroup,
        source: options?.source || 'manual',
        enabled: options?.enabled ?? true,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  } else {
    db.update(schema.accountTokens)
      .set({
        name: options?.name ? normalizeTokenName(options.name) : target.name,
        tokenGroup,
        source: options?.source || target.source || 'manual',
        enabled: options?.enabled ?? target.enabled,
        isDefault: true,
        updatedAt: now,
      })
      .where(eq(schema.accountTokens.id, target.id))
      .run();
  }

  db.update(schema.accountTokens)
    .set({ isDefault: false, updatedAt: now })
    .where(and(eq(schema.accountTokens.accountId, accountId), ne(schema.accountTokens.id, target.id)))
    .run();

  updateAccountApiToken(accountId, normalizedToken);
  return target.id;
}

export function setDefaultToken(tokenId: number): boolean {
  const target = db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, tokenId)).get();
  if (!target) return false;

  const now = new Date().toISOString();
  db.update(schema.accountTokens)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(schema.accountTokens.accountId, target.accountId))
    .run();

  db.update(schema.accountTokens)
    .set({ isDefault: true, enabled: true, updatedAt: now })
    .where(eq(schema.accountTokens.id, tokenId))
    .run();

  updateAccountApiToken(target.accountId, target.token);
  return true;
}

export function repairDefaultToken(accountId: number) {
  const tokens = db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  const enabled = tokens.filter((t) => t.enabled);
  if (enabled.length === 0) {
    updateAccountApiToken(accountId, null);
    return null;
  }

  const currentDefault = enabled.find((t) => t.isDefault) || enabled[0];
  const now = new Date().toISOString();

  db.update(schema.accountTokens)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(schema.accountTokens.accountId, accountId))
    .run();

  db.update(schema.accountTokens)
    .set({ isDefault: true, enabled: true, updatedAt: now })
    .where(eq(schema.accountTokens.id, currentDefault.id))
    .run();

  updateAccountApiToken(accountId, currentDefault.token);
  return currentDefault;
}

export function syncTokensFromUpstream(accountId: number, upstreamTokens: UpstreamApiToken[]) {
  const now = new Date().toISOString();
  const existing = db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  let created = 0;
  let updated = 0;
  let index = existing.length + 1;

  for (const upstream of upstreamTokens) {
    const tokenValue = normalizeTokenValue(upstream.key);
    if (!tokenValue) continue;

    const tokenName = normalizeTokenName(upstream.name, index);
    const enabled = upstream.enabled ?? true;
    const tokenGroup = normalizeTokenGroup(upstream.tokenGroup, tokenName);

    const byToken = existing.find((row) => row.token === tokenValue);
    if (byToken) {
      db.update(schema.accountTokens)
        .set({
          name: tokenName,
          tokenGroup,
          source: 'sync',
          enabled,
          updatedAt: now,
        })
        .where(eq(schema.accountTokens.id, byToken.id))
        .run();
      byToken.name = tokenName;
      byToken.tokenGroup = tokenGroup;
      byToken.enabled = enabled;
      byToken.source = 'sync';
      byToken.updatedAt = now;
      updated++;
      continue;
    }

    const createdRow = db.insert(schema.accountTokens)
      .values({
        accountId,
        name: tokenName,
        token: tokenValue,
        tokenGroup,
        source: 'sync',
        enabled,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    existing.push(createdRow);
    created++;
    index++;
  }

  const repaired = repairDefaultToken(accountId);

  return {
    created,
    updated,
    total: existing.length,
    defaultTokenId: repaired?.id || null,
  };
}

export function listTokensWithRelations(accountId?: number) {
  const base = db.select()
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id));

  const rows = accountId
    ? base.where(eq(schema.accountTokens.accountId, accountId)).all()
    : base.all();

  return rows.map((row) => {
    const { token, ...tokenMeta } = row.account_tokens;
    return {
      ...tokenMeta,
      tokenMasked: maskToken(token, row.sites.platform),
      account: {
        id: row.accounts.id,
        username: row.accounts.username,
        status: row.accounts.status,
      },
      site: {
        id: row.sites.id,
        name: row.sites.name,
        url: row.sites.url,
        platform: row.sites.platform,
      },
    };
  });
}

