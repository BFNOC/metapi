import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { clearRouteDecisionSnapshots } from './routeDecisionSnapshotStore.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';

export type ChannelPriorityUpdate = {
  id: number;
  priority: number;
};

export async function clearDependentExplicitGroupSnapshotsBySourceRouteIds(sourceRouteIds: number[]): Promise<void> {
  const normalizedSourceRouteIds = Array.from(new Set(
    sourceRouteIds.filter((routeId): routeId is number => Number.isFinite(routeId) && routeId > 0),
  ));
  if (normalizedSourceRouteIds.length === 0) return;

  const rows = await db.select({ groupRouteId: schema.routeGroupSources.groupRouteId })
    .from(schema.routeGroupSources)
    .where(inArray(schema.routeGroupSources.sourceRouteId, normalizedSourceRouteIds))
    .all();
  const dependentRouteIdSet = new Set<number>();
  for (const row of rows) {
    const routeId = Number(row.groupRouteId);
    if (Number.isFinite(routeId) && routeId > 0) {
      dependentRouteIdSet.add(routeId);
    }
  }
  const dependentRouteIds = Array.from(dependentRouteIdSet);
  if (dependentRouteIds.length === 0) return;
  await clearRouteDecisionSnapshots(dependentRouteIds);
}

export async function applyChannelPriorityUpdates(input: {
  existingChannels: Array<typeof schema.routeChannels.$inferSelect>;
  updates: ChannelPriorityUpdate[];
}): Promise<Array<typeof schema.routeChannels.$inferSelect>> {
  const channelIds = Array.from(new Set(
    input.updates
      .map((update) => Math.trunc(update.id))
      .filter((id) => id > 0),
  ));
  if (channelIds.length === 0) return [];

  const updateMap = new Map<number, number>();
  for (const update of input.updates) {
    const channelId = Math.trunc(update.id);
    if (channelId <= 0) continue;
    updateMap.set(channelId, Math.max(0, Math.trunc(update.priority)));
  }

  await db.transaction(async (tx) => {
    for (const channelId of channelIds) {
      const priority = updateMap.get(channelId);
      if (priority == null) continue;
      await tx.update(schema.routeChannels).set({
        priority,
        manualOverride: true,
      }).where(eq(schema.routeChannels.id, channelId)).run();
    }
  });

  const routeIds = Array.from(new Set(
    input.existingChannels
      .map((channel) => channel.routeId)
      .filter((routeId): routeId is number => Number.isFinite(routeId) && routeId > 0),
  ));
  await clearRouteDecisionSnapshots(routeIds);
  await clearDependentExplicitGroupSnapshotsBySourceRouteIds(routeIds);
  invalidateTokenRouterCache();

  return await db.select().from(schema.routeChannels)
    .where(inArray(schema.routeChannels.id, channelIds))
    .all();
}
