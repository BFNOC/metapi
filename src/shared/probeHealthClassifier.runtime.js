/**
 * Probe health status classifier
 *
 * Derives display-layer health status from raw probe results.
 * Does NOT modify raw status or persistence logic.
 */
export function deriveProbeHealthStatus(status, httpStatus, error) {
    if (status === 'supported')
        return 'success';
    if (status === 'skipped') {
        if (httpStatus != null)
            return 'failure';
        return 'skipped';
    }
    if (status === 'unsupported')
        return 'failure';
    const errorLower = error?.toLowerCase() || '';
    if (httpStatus && httpStatus >= 500)
        return 'failure';
    if (errorLower.includes('timeout after'))
        return 'failure';
    if (errorLower.includes('fetch failed'))
        return 'failure';
    if (errorLower.includes('bad gateway'))
        return 'failure';
    if (errorLower.includes('service temporarily'))
        return 'failure';
    if (errorLower.includes('overload'))
        return 'failure';
    if (errorLower.includes('无可用渠道'))
        return 'failure';
    if (errorLower.includes('unknown provider'))
        return 'failure';
    if (errorLower.includes('<!doctype html>'))
        return 'failure';
    if (errorLower.includes('<html'))
        return 'failure';
    return 'unknown';
}
export function aggregateProbeHealthStats(results) {
    let successCount = 0;
    let failureCount = 0;
    let unknownCount = 0;
    let skippedCount = 0;
    for (const result of results) {
        const health = deriveProbeHealthStatus(result.status, result.httpStatus, result.error);
        if (health === 'success')
            successCount++;
        else if (health === 'failure')
            failureCount++;
        else if (health === 'unknown')
            unknownCount++;
        else if (health === 'skipped')
            skippedCount++;
    }
    return { successCount, failureCount, unknownCount, skippedCount };
}
