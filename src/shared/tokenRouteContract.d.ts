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
        /** Error-only combined multiplier (0.02 ~ 1.0) */
        combinedMultiplier: number;
        /** Site-level circuit breaker active */
        globalBreakerOpen: boolean;
        /** Model-level circuit breaker active */
        modelBreakerOpen: boolean;
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
