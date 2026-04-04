export type ProbeHealthStatus = 'success' | 'failure' | 'unknown' | 'skipped';
export declare function deriveProbeHealthStatus(
  status: 'supported' | 'unsupported' | 'inconclusive' | 'skipped',
  httpStatus: number | null,
  error: string | null
): ProbeHealthStatus;
export declare function aggregateProbeHealthStats(
  results: Array<{ status: string; httpStatus: number | null; error: string | null }>
): {
  successCount: number;
  failureCount: number;
  unknownCount: number;
  skippedCount: number;
};
