import { useState, useCallback } from 'react';
import { api } from '../../api.js';
import { normalizeChannels } from './utils.js';
import type { RouteChannel } from './types.js';

export function useRouteChannels() {
  const [channelsByRouteId, setChannelsByRouteId] = useState<Record<number, RouteChannel[]>>({});
  const [loadingChannelsByRouteId, setLoadingChannelsByRouteId] = useState<Record<number, boolean>>({});

  const loadChannels = useCallback(async (routeId: number, force = false) => {
    if (!force && channelsByRouteId[routeId]) return channelsByRouteId[routeId];
    setLoadingChannelsByRouteId((prev) => ({ ...prev, [routeId]: true }));
    try {
      const channels = await api.getRouteChannels(routeId);
      const sorted = normalizeChannels(channels || []);
      setChannelsByRouteId((prev) => ({ ...prev, [routeId]: sorted }));
      return sorted;
    } finally {
      setLoadingChannelsByRouteId((prev) => ({ ...prev, [routeId]: false }));
    }
  }, [channelsByRouteId]);

  const invalidateChannels = useCallback((routeId: number) => {
    setChannelsByRouteId((prev) => {
      const next = { ...prev };
      delete next[routeId];
      return next;
    });
  }, []);

  const setChannels = useCallback((routeId: number, channels: RouteChannel[]) => {
    setChannelsByRouteId((prev) => ({ ...prev, [routeId]: channels }));
  }, []);

  return {
    channelsByRouteId,
    loadingChannelsByRouteId,
    loadChannels,
    invalidateChannels,
    setChannels,
  };
}
