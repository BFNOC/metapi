import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { probeModels } from '../../services/modelProbeService.js';
import { deriveSiteProbePolicy, listSiteHealthStates } from '../../services/siteHealthSignals.js';
import { isExactTokenRouteModelPattern } from '../../../shared/tokenRoutePatterns.js';
import { resolveProbePrompt } from '../../../shared/probePrompts.js';

type ManualVerifyCandidate = {
  modelName: string | null;
  source: 'route' | 'availability' | 'allow_list' | 'none';
};

async function resolveSiteProbeApiToken(
  siteId: number,
  siteApiKey: string | null,
): Promise<string | null> {
  if (siteApiKey) return siteApiKey;

  const account = await db.select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.siteId, siteId), eq(schema.accounts.status, 'active')))
    .get();
  if (!account) return null;

  if (account.apiToken) return account.apiToken;

  const token = await db.select()
    .from(schema.accountTokens)
    .where(and(eq(schema.accountTokens.accountId, account.id), eq(schema.accountTokens.enabled, true)))
    .get();
  return token?.token || null;
}

async function resolveManualVerifyCandidate(siteId: number): Promise<ManualVerifyCandidate> {
  const routeCandidates = await db.select({
    sourceModel: schema.routeChannels.sourceModel,
    modelPattern: schema.tokenRoutes.modelPattern,
  }).from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
    .where(and(
      eq(schema.accounts.siteId, siteId),
      eq(schema.accounts.status, 'active'),
      eq(schema.routeChannels.enabled, true),
      eq(schema.tokenRoutes.enabled, true),
    ))
    .all();

  for (const row of routeCandidates) {
    const sourceModel = String(row.sourceModel || '').trim();
    if (sourceModel) {
      return { modelName: sourceModel, source: 'route' };
    }
    const modelPattern = String(row.modelPattern || '').trim();
    if (modelPattern && isExactTokenRouteModelPattern(modelPattern)) {
      return { modelName: modelPattern, source: 'route' };
    }
  }

  const availableAccountModel = await db.select({
    modelName: schema.modelAvailability.modelName,
  }).from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .where(and(
      eq(schema.accounts.siteId, siteId),
      eq(schema.accounts.status, 'active'),
      eq(schema.modelAvailability.available, true),
    ))
    .get();
  if (availableAccountModel?.modelName) {
    return { modelName: availableAccountModel.modelName, source: 'availability' };
  }

  const availableTokenModel = await db.select({
    modelName: schema.tokenModelAvailability.modelName,
  }).from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .where(and(
      eq(schema.accounts.siteId, siteId),
      eq(schema.accounts.status, 'active'),
      eq(schema.accountTokens.enabled, true),
      eq(schema.tokenModelAvailability.available, true),
    ))
    .get();
  if (availableTokenModel?.modelName) {
    return { modelName: availableTokenModel.modelName, source: 'availability' };
  }

  const allowListModel = await db.select({
    modelName: schema.siteAllowedModels.modelName,
  }).from(schema.siteAllowedModels)
    .where(eq(schema.siteAllowedModels.siteId, siteId))
    .get();
  if (allowListModel?.modelName) {
    return { modelName: allowListModel.modelName, source: 'allow_list' };
  }

  return { modelName: null, source: 'none' };
}

export async function siteHealthRoutes(app: FastifyInstance) {
  app.get('/api/site-health/states', async () => {
    if (!config.enableSiteHealthSignals) {
      return { enabled: false, items: [] };
    }

    const items = await listSiteHealthStates();
    return { enabled: true, items };
  });

  app.post<{ Params: { siteId: string }; Body?: { prompt?: string; timeoutMs?: number } }>(
    '/api/site-health/manual-verify/:siteId',
    async (request, reply) => {
      if (!config.siteHealthEnableManualVerifyEntry) {
        return reply.code(403).send({ success: false, message: '站点健康手动验证入口已禁用' });
      }

      const siteId = Number.parseInt(request.params.siteId, 10);
      if (!Number.isFinite(siteId) || siteId <= 0) {
        return reply.code(400).send({ success: false, message: '无效的站点 ID' });
      }

      const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
      if (!site) {
        return reply.code(404).send({ success: false, message: '站点不存在' });
      }

      const probePolicy = deriveSiteProbePolicy({
        siteStatus: site.status,
        probeDisabled: !!site.probeDisabled,
      });
      if (probePolicy === 'forbid_batch_probe') {
        return reply.code(409).send({ success: false, message: '当前站点状态不允许执行手动验证' });
      }

      const apiToken = await resolveSiteProbeApiToken(siteId, site.apiKey || null);
      if (!apiToken) {
        return reply.code(400).send({ success: false, message: '该站点缺少可用 API Token，无法执行手动验证' });
      }

      const candidate = await resolveManualVerifyCandidate(siteId);
      if (!candidate.modelName) {
        return reply.code(400).send({ success: false, message: '未找到可用于手动验证的模型' });
      }

      const [result] = await probeModels({
        siteUrl: site.url,
        apiToken,
        modelNames: [candidate.modelName],
        prompt: resolveProbePrompt(request.body?.prompt),
        concurrency: 1,
        timeoutMs: Math.max(5_000, Math.min(60_000, Number(request.body?.timeoutMs || 30_000))),
        delayMs: 0,
      });

      return {
        success: true,
        siteId: site.id,
        siteName: site.name,
        probePolicy,
        candidateModel: candidate.modelName,
        candidateSource: candidate.source,
        recoveryHint: result?.status === 'supported',
        message: result?.status === 'supported'
          ? '单次验证成功，可作为 recovering 的补充证据'
          : '单次验证未成功，仅作为补充证据，不会直接恢复站点',
        result: result || null,
      };
    },
  );
}
