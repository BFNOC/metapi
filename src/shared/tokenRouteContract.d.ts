export type RouteMode = 'pattern' | 'explicit_group';
export type RouteDecisionCandidate = {
    channelId: number;
    accountId: number;
    username: string;
    siteName: string;
    tokenName: string;
    priority: number;
    weight: number;
    eligible: boolean;
    recentlyFailed: boolean;
    avoidedByRecentFailure: boolean;
    probability: number;
    reason: string;
    /** Runtime health observability — error-driven, latency is display-only */
    runtimeHealth?: {
        /** Error-only health multiplier (0.02 ~ 1.0), single (siteId, model) bucket */
        combinedMultiplier: number;
        /** Circuit breaker active for this (site, model) pair */
        breakerOpen: boolean;
        /** Latency EMA in ms — observability only, NOT used in routing */
        latencyEmaMs: number | null;
        /** Current decayed penalty score */
        penaltyScore: number;
    } | null;
};
export type RouteDecision = {
    requestedModel: string;
    actualModel: string;
    matched: boolean;
    selectedChannelId?: number;
    selectedLabel?: string;
    summary: string[];
    candidates: RouteDecisionCandidate[];
};
export declare function normalizeTokenRouteMode(routeMode: unknown): RouteMode;
