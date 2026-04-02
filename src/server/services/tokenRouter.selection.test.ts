import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');
type ProxyChannelCoordinatorModule = typeof import('./proxyChannelCoordinator.js');

const mockedCatalogRoutingCost = vi.fn<(
  input: { siteId: number; accountId: number; modelName: string }
) => number | null>(() => null);

vi.mock('./modelPricingService.js', async () => {
  const actual = await vi.importActual<typeof import('./modelPricingService.js')>('./modelPricingService.js');
  return {
    ...actual,
    getCachedModelRoutingReferenceCost: mockedCatalogRoutingCost,
  };
});

describe('TokenRouter selection scoring', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let ensureSiteCompatibilityColumns: DbModule['ensureSiteCompatibilityColumns'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let resetStableFirstObservationState: TokenRouterModule['resetStableFirstObservationState'];
  let flushSiteRuntimeHealthPersistence: TokenRouterModule['flushSiteRuntimeHealthPersistence'];
  let config: ConfigModule['config'];
  let proxyChannelCoordinator: ProxyChannelCoordinatorModule['proxyChannelCoordinator'];
  let resetProxyChannelCoordinatorState: ProxyChannelCoordinatorModule['resetProxyChannelCoordinatorState'];
  let dataDir = '';
  let idSeed = 0;
  let originalRoutingWeights: typeof config.routingWeights;
  let originalRoutingFallbackUnitCost: number;
  let originalProxySessionChannelConcurrencyLimit: number;
  let originalProxySessionChannelQueueWaitMs: number;
  let originalProxySessionChannelLeaseTtlMs: number;
  let originalProxySessionChannelLeaseKeepaliveMs: number;

  const nextId = () => {
    idSeed += 1;
    return idSeed;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-selection-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const configModule = await import('../config.js');
    const proxyChannelCoordinatorModule = await import('./proxyChannelCoordinator.js');
    db = dbModule.db;
    schema = dbModule.schema;
    ensureSiteCompatibilityColumns = dbModule.ensureSiteCompatibilityColumns;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    resetStableFirstObservationState = tokenRouterModule.resetStableFirstObservationState;
    flushSiteRuntimeHealthPersistence = tokenRouterModule.flushSiteRuntimeHealthPersistence;
    config = configModule.config;
    proxyChannelCoordinator = proxyChannelCoordinatorModule.proxyChannelCoordinator;
    resetProxyChannelCoordinatorState = proxyChannelCoordinatorModule.resetProxyChannelCoordinatorState;
    originalRoutingWeights = { ...config.routingWeights };
    originalRoutingFallbackUnitCost = config.routingFallbackUnitCost;
    originalProxySessionChannelConcurrencyLimit = config.proxySessionChannelConcurrencyLimit;
    originalProxySessionChannelQueueWaitMs = config.proxySessionChannelQueueWaitMs;
    originalProxySessionChannelLeaseTtlMs = config.proxySessionChannelLeaseTtlMs;
    originalProxySessionChannelLeaseKeepaliveMs = config.proxySessionChannelLeaseKeepaliveMs;
  });

  beforeEach(async () => {
    idSeed = 0;
    mockedCatalogRoutingCost.mockReset();
    mockedCatalogRoutingCost.mockReturnValue(null);
    await ensureSiteCompatibilityColumns();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    resetStableFirstObservationState();
    resetProxyChannelCoordinatorState();
  });

  afterAll(() => {
    config.routingWeights = { ...originalRoutingWeights };
    config.routingFallbackUnitCost = originalRoutingFallbackUnitCost;
    config.proxySessionChannelConcurrencyLimit = originalProxySessionChannelConcurrencyLimit;
    config.proxySessionChannelQueueWaitMs = originalProxySessionChannelQueueWaitMs;
    config.proxySessionChannelLeaseTtlMs = originalProxySessionChannelLeaseTtlMs;
    config.proxySessionChannelLeaseKeepaliveMs = originalProxySessionChannelLeaseKeepaliveMs;
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    resetStableFirstObservationState();
    resetProxyChannelCoordinatorState();
    delete process.env.DATA_DIR;
  });

  async function createRoute(modelPattern: string) {
    return await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();
  }

  async function createSite(namePrefix: string) {
    const id = nextId();
    return await db.insert(schema.sites).values({
      name: `${namePrefix}-${id}`,
      url: `https://${namePrefix}-${id}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
  }

  async function createAccount(siteId: number, usernamePrefix: string) {
    const id = nextId();
    return await db.insert(schema.accounts).values({
      siteId,
      username: `${usernamePrefix}-${id}`,
      accessToken: `access-${id}`,
      apiToken: `sk-${id}`,
      status: 'active',
    }).returning().get();
  }

  async function createToken(accountId: number, name: string) {
    return await db.insert(schema.accountTokens).values({
      accountId,
      name,
      token: `token-${name}-${nextId()}`,
      enabled: true,
      isDefault: false,
    }).returning().get();
  }

  it('reuses a preferred channel only while it remains healthy', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-5.2');
    const site = await createSite('sticky-site');
    const account = await createAccount(site.id, 'sticky-user');
    const tokenA = await createToken(account.id, 'sticky-a');
    const tokenB = await createToken(account.id, 'sticky-b');

    const preferredChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
      failCount: 0,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
      failCount: 0,
    }).run();

    const router = new TokenRouter();
    const selected = await router.selectPreferredChannel('gpt-5.2', preferredChannel.id);
    expect(selected?.channel.id).toBe(preferredChannel.id);

    await db.update(schema.routeChannels).set({
      failCount: 4,
      consecutiveFailCount: 4,
      lastFailAt: new Date().toISOString(),
    }).where(eq(schema.routeChannels.id, preferredChannel.id)).run();
    invalidateTokenRouterCache();

    await expect(router.selectPreferredChannel('gpt-5.2', preferredChannel.id)).resolves.toBeNull();
  });

  it('normalizes probability across channels on the same site', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('claude-haiku-4-5-20251001');

    const siteA = await createSite('site-a');
    const accountA = await createAccount(siteA.id, 'user-a');
    const tokenA1 = await createToken(accountA.id, 'a-1');
    const tokenA2 = await createToken(accountA.id, 'a-2');

    const siteB = await createSite('site-b');
    const accountB = await createAccount(siteB.id, 'user-b');
    const tokenB = await createToken(accountB.id, 'b-1');

    const channelA1 = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA1.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const channelA2 = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA2.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const decision = await new TokenRouter().explainSelection('claude-haiku-4-5-20251001');
    const probMap = new Map(decision.candidates.map((candidate) => [candidate.channelId, candidate.probability]));

    const probA1 = probMap.get(channelA1.id) ?? 0;
    const probA2 = probMap.get(channelA2.id) ?? 0;
    const probB = probMap.get(channelB.id) ?? 0;

    expect(probA1).toBeCloseTo(25, 1);
    expect(probA2).toBeCloseTo(25, 1);
    expect(probB).toBeCloseTo(50, 1);
    expect(probA1 + probA2).toBeCloseTo(probB, 1);
  });

  it('uses observed channel cost from real routing results when scoring cost priority', async () => {
    config.routingWeights = {
      baseWeightFactor: 0.35,
      valueScoreFactor: 0.65,
      costWeight: 1,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('claude-opus-4-6');

    const siteCheap = await createSite('cheap-site');
    const accountCheap = await createAccount(siteCheap.id, 'cheap-user');
    const tokenCheap = await createToken(accountCheap.id, 'cheap-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountCheap.id,
      tokenId: tokenCheap.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 10,
      failCount: 0,
      totalCost: 0.01,
    }).run();

    const siteExpensive = await createSite('expensive-site');
    const accountExpensive = await createAccount(siteExpensive.id, 'expensive-user');
    const tokenExpensive = await createToken(accountExpensive.id, 'exp-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountExpensive.id,
      tokenId: tokenExpensive.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 10,
      failCount: 0,
      totalCost: 0.1,
    }).run();

    const decision = await new TokenRouter().explainSelection('claude-opus-4-6');
    const cheapCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('cheap-site'));
    const expensiveCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('expensive-site'));

    expect(cheapCandidate).toBeTruthy();
    expect(expensiveCandidate).toBeTruthy();
    expect((cheapCandidate?.probability || 0)).toBeGreaterThan(expensiveCandidate?.probability || 0);
    expect(cheapCandidate?.reason || '').toContain('成本=实测');
    expect(expensiveCandidate?.reason || '').toContain('成本=实测');
  });

  it('uses runtime-configured fallback unit cost when observed and configured costs are missing', async () => {
    config.routingWeights = {
      baseWeightFactor: 0.35,
      valueScoreFactor: 0.65,
      costWeight: 1,
      balanceWeight: 0,
      usageWeight: 0,
    };
    config.routingFallbackUnitCost = 0.02;

    const route = await createRoute('claude-sonnet-4-6');

    const siteFallback = await createSite('fallback-site');
    const accountFallback = await createAccount(siteFallback.id, 'fallback-user');
    const tokenFallback = await createToken(accountFallback.id, 'fallback-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountFallback.id,
      tokenId: tokenFallback.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 0,
      failCount: 0,
      totalCost: 0,
    }).run();

    const siteObserved = await createSite('observed-site');
    const accountObserved = await createAccount(siteObserved.id, 'observed-user');
    const tokenObserved = await createToken(accountObserved.id, 'observed-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountObserved.id,
      tokenId: tokenObserved.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 10,
      failCount: 0,
      totalCost: 2, // unit cost 0.2
    }).run();

    const decision = await new TokenRouter().explainSelection('claude-sonnet-4-6');
    const fallbackCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('fallback-site'));
    const observedCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('observed-site'));

    expect(fallbackCandidate).toBeTruthy();
    expect(observedCandidate).toBeTruthy();
    expect((fallbackCandidate?.probability || 0)).toBeGreaterThan(observedCandidate?.probability || 0);
    expect(fallbackCandidate?.reason || '').toContain('成本=默认:0.020000');
  });

  it('penalizes fallback-cost channels when fallback unit cost is set very high', async () => {
    config.routingWeights = {
      baseWeightFactor: 0.35,
      valueScoreFactor: 0.65,
      costWeight: 0.75,
      balanceWeight: 0.15,
      usageWeight: 0.1,
    };
    config.routingFallbackUnitCost = 1000;

    const route = await createRoute('gpt-5-nano');

    const siteFallback = await createSite('fallback-high-balance');
    const accountFallback = await db.insert(schema.accounts).values({
      siteId: siteFallback.id,
      username: `fallback-high-balance-${nextId()}`,
      accessToken: `access-${nextId()}`,
      apiToken: `sk-${nextId()}`,
      status: 'active',
      balance: 10_000,
    }).returning().get();
    const tokenFallback = await createToken(accountFallback.id, 'fallback-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountFallback.id,
      tokenId: tokenFallback.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 0,
      failCount: 0,
      totalCost: 0,
    }).run();

    const siteObserved = await createSite('observed-low-balance');
    const accountObserved = await db.insert(schema.accounts).values({
      siteId: siteObserved.id,
      username: `observed-low-balance-${nextId()}`,
      accessToken: `access-${nextId()}`,
      apiToken: `sk-${nextId()}`,
      status: 'active',
      balance: 0,
    }).returning().get();
    const tokenObserved = await createToken(accountObserved.id, 'observed-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountObserved.id,
      tokenId: tokenObserved.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 10,
      failCount: 0,
      totalCost: 10, // observed unit cost = 1
    }).run();

    const decision = await new TokenRouter().explainSelection('gpt-5-nano');
    const fallbackCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('fallback-high-balance'));
    const observedCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('observed-low-balance'));

    expect(fallbackCandidate).toBeTruthy();
    expect(observedCandidate).toBeTruthy();
    expect((fallbackCandidate?.probability || 0)).toBeLessThan(1);
    expect((observedCandidate?.probability || 0)).toBeGreaterThan(99);
    expect(fallbackCandidate?.reason || '').toContain('成本=默认:1000.000000');
  });

  it('uses cached catalog routing cost when observed and configured costs are missing', async () => {
    config.routingWeights = {
      baseWeightFactor: 0.35,
      valueScoreFactor: 0.65,
      costWeight: 1,
      balanceWeight: 0,
      usageWeight: 0,
    };
    config.routingFallbackUnitCost = 100;

    const route = await createRoute('claude-sonnet-4-5-20250929');

    const siteCatalog = await createSite('catalog-site');
    const accountCatalog = await createAccount(siteCatalog.id, 'catalog-user');
    const tokenCatalog = await createToken(accountCatalog.id, 'catalog-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountCatalog.id,
      tokenId: tokenCatalog.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 0,
      failCount: 0,
      totalCost: 0,
    }).run();

    const siteFallback = await createSite('fallback-site');
    const accountFallback = await createAccount(siteFallback.id, 'fallback-user');
    const tokenFallback = await createToken(accountFallback.id, 'fallback-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountFallback.id,
      tokenId: tokenFallback.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 0,
      failCount: 0,
      totalCost: 0,
    }).run();

    mockedCatalogRoutingCost.mockImplementation(({ accountId, modelName }) => {
      if (accountId !== accountCatalog.id) return null;
      if (modelName !== 'claude-sonnet-4-5-20250929') return null;
      return 0.2;
    });

    const decision = await new TokenRouter().explainSelection('claude-sonnet-4-5-20250929');
    const catalogCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('catalog-site'));
    const fallbackCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('fallback-site'));

    expect(catalogCandidate).toBeTruthy();
    expect(fallbackCandidate).toBeTruthy();
    expect((catalogCandidate?.probability || 0)).toBeGreaterThan(fallbackCandidate?.probability || 0);
    expect(catalogCandidate?.reason || '').toContain('成本=目录:0.200000');
    expect(fallbackCandidate?.reason || '').toContain('成本=默认:100.000000');
  });

  it('downweights a site after transient failures and restores it quickly after success', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-5.4');

    const siteA = await createSite('runtime-a');
    const accountA = await createAccount(siteA.id, 'runtime-user-a');
    const tokenA = await createToken(accountA.id, 'runtime-token-a');
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteB = await createSite('runtime-b');
    const accountB = await createAccount(siteB.id, 'runtime-user-b');
    const tokenB = await createToken(accountB.id, 'runtime-token-b');
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    let decision = await router.explainSelection('gpt-5.4');
    let candidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    let candidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);
    expect(candidateA?.probability).toBeCloseTo(50, 1);
    expect(candidateB?.probability).toBeCloseTo(50, 1);

    await router.recordFailure(channelA.id, {
      status: 502,
      errorText: 'Bad gateway',
      modelName: 'gpt-5.4',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, channelA.id)).run();
    invalidateTokenRouterCache();

    decision = await router.explainSelection('gpt-5.4');
    candidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    candidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);
    expect(candidateA).toBeTruthy();
    expect(candidateB).toBeTruthy();
    expect((candidateA?.probability || 0)).toBeLessThan(30);
    expect(candidateA?.reason || '').toContain('运行时健康=');
    expect((candidateB?.probability || 0)).toBeGreaterThan(70);

    await router.recordSuccess(channelA.id, 800, 0, 'gpt-5.4');
    invalidateTokenRouterCache();

    decision = await router.explainSelection('gpt-5.4');
    candidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    candidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);
    expect((candidateA?.probability || 0)).toBeGreaterThan(25);
    expect((candidateB?.probability || 0)).toBeLessThan(75);
  });

  it('opens a site breaker after repeated transient failures and closes it after recovery', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-5.3');

    const siteA = await createSite('breaker-a');
    const accountA = await createAccount(siteA.id, 'breaker-user-a');
    const tokenA = await createToken(accountA.id, 'breaker-token-a');
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteB = await createSite('breaker-b');
    const accountB = await createAccount(siteB.id, 'breaker-user-b');
    const tokenB = await createToken(accountB.id, 'breaker-token-b');
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    for (let index = 0; index < 3; index += 1) {
      await router.recordFailure(channelA.id, {
        status: 502,
        errorText: 'Gateway timeout',
        modelName: 'gpt-5.3',
      });
    }
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, channelA.id)).run();
    invalidateTokenRouterCache();

    let decision = await router.explainSelection('gpt-5.3');
    const breakerCandidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    const breakerCandidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);
    expect(breakerCandidateA?.reason || '').toContain('熔断中');
    expect((breakerCandidateA?.probability || 0)).toBe(0);
    expect((breakerCandidateB?.probability || 0)).toBe(100);
    expect(decision.summary.join(' ')).toContain('站点熔断避让');

    await router.recordSuccess(channelA.id, 600, 0, 'gpt-5.3');
    invalidateTokenRouterCache();

    decision = await router.explainSelection('gpt-5.3');
    const recoveredCandidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    const recoveredCandidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);
    expect((recoveredCandidateA?.probability || 0)).toBeGreaterThan(15);
    expect((recoveredCandidateB?.probability || 0)).toBeLessThan(85);
  });

  it('does not open a site breaker for repeated timeout validation errors', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-5.4');

    const siteA = await createSite('timeout-validation-a');
    const accountA = await createAccount(siteA.id, 'timeout-validation-user-a');
    const tokenA = await createToken(accountA.id, 'timeout-validation-token-a');
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteB = await createSite('timeout-validation-b');
    const accountB = await createAccount(siteB.id, 'timeout-validation-user-b');
    const tokenB = await createToken(accountB.id, 'timeout-validation-token-b');
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    for (let index = 0; index < 3; index += 1) {
      await router.recordFailure(channelA.id, {
        status: 400,
        errorText: 'invalid timeout parameter',
      });
    }
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, channelA.id)).run();
    invalidateTokenRouterCache();

    const decision = await router.explainSelection('gpt-5.4');
    const candidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    const candidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);

    expect(candidateA).toBeTruthy();
    expect(candidateB).toBeTruthy();
    expect(candidateA?.reason || '').not.toContain('站点熔断');
    expect(candidateB?.reason || '').not.toContain('站点熔断');
    expect(decision.summary.join(' ')).not.toContain('站点熔断避让');
    expect((candidateA?.probability || 0)).toBeGreaterThan(0);
  });

  it('uses persisted site success and latency history to prefer historically healthier sites', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('claude-4-sonnet');

    const siteStable = await createSite('history-stable');
    const accountStable = await createAccount(siteStable.id, 'history-user-stable');
    const tokenStable = await createToken(accountStable.id, 'history-token-stable');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountStable.id,
      tokenId: tokenStable.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 90,
      failCount: 10,
      totalLatencyMs: 90 * 240,
    }).run();

    const siteWeak = await createSite('history-weak');
    const accountWeak = await createAccount(siteWeak.id, 'history-user-weak');
    const tokenWeak = await createToken(accountWeak.id, 'history-token-weak');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountWeak.id,
      tokenId: tokenWeak.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 20,
      failCount: 30,
      totalLatencyMs: 20 * 5200,
    }).run();

    const decision = await new TokenRouter().explainSelection('claude-4-sonnet');
    const stableCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('history-stable'));
    const weakCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('history-weak'));

    expect(stableCandidate).toBeTruthy();
    expect(weakCandidate).toBeTruthy();
    expect((stableCandidate?.probability || 0)).toBeGreaterThan(weakCandidate?.probability || 0);
    expect(stableCandidate?.reason || '').toContain('历史健康=');
    expect(stableCandidate?.reason || '').toContain('成功率=90.0%');
    expect(weakCandidate?.reason || '').toContain('成功率=40.0%');
  });

  it('reloads persisted runtime health after in-memory reset', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-4o-mini');

    const siteA = await createSite('persist-a');
    const accountA = await createAccount(siteA.id, 'persist-user-a');
    const tokenA = await createToken(accountA.id, 'persist-token-a');
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteB = await createSite('persist-b');
    const accountB = await createAccount(siteB.id, 'persist-user-b');
    const tokenB = await createToken(accountB.id, 'persist-token-b');
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channelA.id, {
      status: 502,
      errorText: 'Gateway timeout',
      modelName: 'gpt-4o-mini',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, channelA.id)).run();
    await flushSiteRuntimeHealthPersistence();

    const persisted = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'token_router_site_runtime_health_v1'))
      .get();
    expect(persisted?.value).toBeTruthy();

    resetSiteRuntimeHealthState();
    invalidateTokenRouterCache();

    const decision = await new TokenRouter().explainSelection('gpt-4o-mini');
    const candidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    const candidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);

    expect(candidateA).toBeTruthy();
    expect(candidateB).toBeTruthy();
    expect((candidateA?.probability || 0)).toBeLessThan((candidateB?.probability || 0));
    expect(candidateA?.reason || '').toContain('运行时健康=');
  });

  it('penalizes the failed model more than unrelated models on the same site', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const gptRoute = await createRoute('gpt-5.4');
    const claudeRoute = await createRoute('claude-sonnet-4-6');

    const siteA = await createSite('model-aware-a');
    const accountA = await createAccount(siteA.id, 'model-aware-user-a');
    const tokenA = await createToken(accountA.id, 'model-aware-token-a');
    const gptChannelA = await db.insert(schema.routeChannels).values({
      routeId: gptRoute.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: claudeRoute.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const siteB = await createSite('model-aware-b');
    const accountB = await createAccount(siteB.id, 'model-aware-user-b');
    const tokenB = await createToken(accountB.id, 'model-aware-token-b');
    await db.insert(schema.routeChannels).values([
      {
        routeId: gptRoute.id,
        accountId: accountB.id,
        tokenId: tokenB.id,
        priority: 0,
        weight: 10,
        enabled: true,
      },
      {
        routeId: claudeRoute.id,
        accountId: accountB.id,
        tokenId: tokenB.id,
        priority: 0,
        weight: 10,
        enabled: true,
      },
    ]).run();

    const router = new TokenRouter();
    await router.recordFailure(gptChannelA.id, {
      status: 502,
      errorText: 'Bad gateway',
      modelName: 'gpt-5.4',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, gptChannelA.id)).run();
    invalidateTokenRouterCache();

    const gptDecision = await router.explainSelection('gpt-5.4');
    const claudeDecision = await router.explainSelection('claude-sonnet-4-6');
    const gptCandidateA = gptDecision.candidates.find((candidate) => candidate.siteName.startsWith('model-aware-a'));
    const claudeCandidateA = claudeDecision.candidates.find((candidate) => candidate.siteName.startsWith('model-aware-a'));

    expect(gptCandidateA).toBeTruthy();
    expect(claudeCandidateA).toBeTruthy();
    expect((gptCandidateA?.probability || 0)).toBeLessThan((claudeCandidateA?.probability || 0));
    expect(gptCandidateA?.reason || '').toContain('运行时健康=');
  });

  it('stable_first deterministically chooses the healthiest candidate', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.1',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();

    const siteA = await createSite('stable-first-a');
    const accountA = await createAccount(siteA.id, 'stable-first-user-a');
    const tokenA = await createToken(accountA.id, 'stable-first-token-a');
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteB = await createSite('stable-first-b');
    const accountB = await createAccount(siteB.id, 'stable-first-user-b');
    const tokenB = await createToken(accountB.id, 'stable-first-token-b');
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channelA.id, {
      status: 502,
      errorText: 'Gateway timeout',
      modelName: 'gpt-5.1',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, channelA.id)).run();
    invalidateTokenRouterCache();

    const preview = await router.previewSelectedChannel('gpt-5.1');
    const decision = await router.explainSelection('gpt-5.1');

    expect(preview?.channel.id).toBe(channelB.id);
    expect(decision.summary.join(' ')).toContain('稳定优先');
    expect(decision.selectedChannelId).toBe(channelB.id);
  });

  it('stable_first splits candidates into primary and observation pools', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4.2',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();

    const siteA = await createSite('pool-a');
    const accountA = await createAccount(siteA.id, 'pool-user-a');
    const tokenA = await createToken(accountA.id, 'pool-token-a');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const siteB = await createSite('pool-b');
    const accountB = await createAccount(siteB.id, 'pool-user-b');
    const tokenB = await createToken(accountB.id, 'pool-token-b');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 9,
      enabled: true,
    }).run();

    const siteC = await createSite('pool-c');
    const accountC = await createAccount(siteC.id, 'pool-user-c');
    const tokenC = await createToken(accountC.id, 'pool-token-c');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountC.id,
      tokenId: tokenC.id,
      priority: 0,
      weight: 1,
      enabled: true,
    }).run();

    const decision = await new TokenRouter().explainSelection('gpt-4.2');
    const reasons = decision.candidates.map((candidate) => candidate.reason || '');

    expect(reasons.filter((reason) => reason.includes('主池第'))).toHaveLength(2);
    expect(reasons.filter((reason) => reason.includes('观察池候选第'))).toHaveLength(1);
  });

  it('stable_first samples the observation pool and respects observation site cooldown', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4.3',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();

    const sitePrimaryA = await createSite('observe-primary-a');
    const accountPrimaryA = await createAccount(sitePrimaryA.id, 'observe-user-a');
    const tokenPrimaryA = await createToken(accountPrimaryA.id, 'observe-token-a');
    const primaryChannelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountPrimaryA.id,
      tokenId: tokenPrimaryA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const sitePrimaryB = await createSite('observe-primary-b');
    const accountPrimaryB = await createAccount(sitePrimaryB.id, 'observe-user-b');
    const tokenPrimaryB = await createToken(accountPrimaryB.id, 'observe-token-b');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountPrimaryB.id,
      tokenId: tokenPrimaryB.id,
      priority: 0,
      weight: 9,
      enabled: true,
    }).run();

    const siteObservation = await createSite('observe-observation');
    const accountObservation = await createAccount(siteObservation.id, 'observe-user-c');
    const tokenObservation = await createToken(accountObservation.id, 'observe-token-c');
    const observationChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountObservation.id,
      tokenId: tokenObservation.id,
      priority: 0,
      weight: 1,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    let selectedChannelId: number | null = null;
    for (let index = 1; index <= 24; index += 1) {
      const selected = await router.selectChannel('gpt-4.3');
      selectedChannelId = selected?.channel.id ?? null;
    }
    expect(selectedChannelId).toBe(observationChannel.id);

    selectedChannelId = null;
    for (let index = 25; index <= 48; index += 1) {
      const selected = await router.selectChannel('gpt-4.3');
      selectedChannelId = selected?.channel.id ?? null;
    }
    expect(selectedChannelId).toBe(primaryChannelA.id);
  });

  it('penalizes saturated session-scoped channels with load-aware scoring', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };
    config.proxySessionChannelConcurrencyLimit = 1;
    config.proxySessionChannelQueueWaitMs = 1_000;
    config.proxySessionChannelLeaseTtlMs = 5_000;
    config.proxySessionChannelLeaseKeepaliveMs = 1_000;

    const route = await createRoute('gpt-4o-mini');

    const siteBusy = await createSite('busy-site');
    const accountBusy = await db.insert(schema.accounts).values({
      siteId: siteBusy.id,
      username: `busy-user-${nextId()}`,
      accessToken: `busy-access-${nextId()}`,
      apiToken: `busy-api-${nextId()}`,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();
    const tokenBusy = await createToken(accountBusy.id, 'busy-token');
    const busyChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountBusy.id,
      tokenId: tokenBusy.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteIdle = await createSite('idle-site');
    const accountIdle = await createAccount(siteIdle.id, 'idle-user');
    const tokenIdle = await createToken(accountIdle.id, 'idle-token');
    const idleChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountIdle.id,
      tokenId: tokenIdle.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const firstLease = await proxyChannelCoordinator.acquireChannelLease({
      channelId: busyChannel.id,
      accountExtraConfig: accountBusy.extraConfig,
    });
    expect(firstLease.status).toBe('acquired');
    if (firstLease.status !== 'acquired') return;

    const secondLeasePromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: busyChannel.id,
      accountExtraConfig: accountBusy.extraConfig,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    const decision = await new TokenRouter().explainSelection('gpt-4o-mini');
    const busyCandidate = decision.candidates.find((candidate) => candidate.channelId === busyChannel.id);
    const idleCandidate = decision.candidates.find((candidate) => candidate.channelId === idleChannel.id);

    expect(busyCandidate).toBeTruthy();
    expect(idleCandidate).toBeTruthy();
    expect((busyCandidate?.probability || 0)).toBeLessThan((idleCandidate?.probability || 0));
    expect(busyCandidate?.reason || '').toContain('负载倍率=');

    firstLease.lease.release();
    const secondLease = await secondLeasePromise;
    if (secondLease.status === 'acquired') {
      secondLease.lease.release();
    }
  });

  it('recordProbeSuccess clears cooldown without inflating success metrics', async () => {
    const route = await createRoute('gpt-4.1-mini');
    const site = await createSite('probe-recovery-site');
    const account = await createAccount(site.id, 'probe-recovery-user');
    const token = await createToken(account.id, 'probe-recovery-token');
    const futureCooldown = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 7,
      totalLatencyMs: 321,
      totalCost: 1.25,
      cooldownUntil: futureCooldown,
      lastFailAt: new Date().toISOString(),
      consecutiveFailCount: 4,
      cooldownLevel: 2,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordProbeSuccess(channel.id, 'gpt-4.1-mini');

    const refreshed = await db.select()
      .from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();

    expect(refreshed?.successCount).toBe(7);
    expect(refreshed?.totalLatencyMs).toBe(321);
    expect(refreshed?.totalCost).toBe(1.25);
    expect(refreshed?.cooldownUntil).toBeNull();
    expect(refreshed?.lastFailAt).toBeNull();
    expect(refreshed?.consecutiveFailCount).toBe(0);
    expect(refreshed?.cooldownLevel).toBe(0);
  });

  it('stable_first keeps low-score candidates in the observation pool', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-stable-pool',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();

    const siteA = await createSite('stable-pool-a');
    const accountA = await createAccount(siteA.id, 'stable-pool-user-a');
    const tokenA = await createToken(accountA.id, 'stable-pool-token-a');
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 100,
      enabled: true,
    }).returning().get();

    const siteB = await createSite('stable-pool-b');
    const accountB = await createAccount(siteB.id, 'stable-pool-user-b');
    const tokenB = await createToken(accountB.id, 'stable-pool-token-b');
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 93,
      enabled: true,
    }).returning().get();

    const siteC = await createSite('stable-pool-c');
    const accountC = await createAccount(siteC.id, 'stable-pool-user-c');
    const tokenC = await createToken(accountC.id, 'stable-pool-token-c');
    const channelC = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountC.id,
      tokenId: tokenC.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const decision = await router.explainSelection('gpt-stable-pool');
    const candidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    const candidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);
    const candidateC = decision.candidates.find((candidate) => candidate.channelId === channelC.id);
    const preview = await router.previewSelectedChannel('gpt-stable-pool');

    expect(preview?.channel.id).toBe(channelA.id);
    expect(candidateA?.reason || '').toContain('主池');
    expect(candidateB?.reason || '').toContain('主池');
    expect(candidateC?.reason || '').toContain('观察池');
  });

  it('stable_first samples the observation pool about every 24 selections', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-stable-observe',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();

    const siteA = await createSite('stable-observe-a');
    const accountA = await createAccount(siteA.id, 'stable-observe-user-a');
    const tokenA = await createToken(accountA.id, 'stable-observe-token-a');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 100,
      enabled: true,
    }).run();

    const siteB = await createSite('stable-observe-b');
    const accountB = await createAccount(siteB.id, 'stable-observe-user-b');
    const tokenB = await createToken(accountB.id, 'stable-observe-token-b');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 93,
      enabled: true,
    }).run();

    const siteC = await createSite('stable-observe-c');
    const accountC = await createAccount(siteC.id, 'stable-observe-user-c');
    const tokenC = await createToken(accountC.id, 'stable-observe-token-c');
    const observationChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountC.id,
      tokenId: tokenC.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    for (let index = 0; index < 23; index += 1) {
      const selected = await router.selectChannel('gpt-stable-observe');
      expect(selected?.channel.id).not.toBe(observationChannel.id);
    }

    const observationPick = await router.selectChannel('gpt-stable-observe');
    expect(observationPick?.channel.id).toBe(observationChannel.id);
  });

  it('stable_first rotates observation candidates when the last observed site is cooling down', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-stable-cooldown',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();

    const siteA = await createSite('stable-cooldown-a');
    const accountA = await createAccount(siteA.id, 'stable-cooldown-user-a');
    const tokenA = await createToken(accountA.id, 'stable-cooldown-token-a');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 120,
      enabled: true,
    }).run();

    const siteB = await createSite('stable-cooldown-b');
    const accountB = await createAccount(siteB.id, 'stable-cooldown-user-b');
    const tokenB = await createToken(accountB.id, 'stable-cooldown-token-b');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 111,
      enabled: true,
    }).run();

    const siteC = await createSite('stable-cooldown-c');
    const accountC = await createAccount(siteC.id, 'stable-cooldown-user-c');
    const tokenC = await createToken(accountC.id, 'stable-cooldown-token-c');
    const observationChannelC = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountC.id,
      tokenId: tokenC.id,
      priority: 0,
      weight: 60,
      enabled: true,
    }).returning().get();

    const siteD = await createSite('stable-cooldown-d');
    const accountD = await createAccount(siteD.id, 'stable-cooldown-user-d');
    const tokenD = await createToken(accountD.id, 'stable-cooldown-token-d');
    const observationChannelD = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountD.id,
      tokenId: tokenD.id,
      priority: 0,
      weight: 50,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    for (let index = 0; index < 23; index += 1) {
      await router.selectChannel('gpt-stable-cooldown');
    }
    const firstObservationPick = await router.selectChannel('gpt-stable-cooldown');
    expect(firstObservationPick?.channel.id).toBe(observationChannelC.id);

    for (let index = 0; index < 23; index += 1) {
      await router.selectChannel('gpt-stable-cooldown');
    }
    const secondObservationPick = await router.selectChannel('gpt-stable-cooldown');
    expect(secondObservationPick?.channel.id).toBe(observationChannelD.id);
  });
});
