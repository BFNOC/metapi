.mode column
.headers on
.separator "	"

-- ============================================================
-- 1. 各站点总体延迟与成功率（最近24小时）
-- ============================================================
SELECT '=== 1. 站点延迟与成功率总览 ===' AS section;
SELECT
  s.name AS site_name,
  COUNT(*) AS total_calls,
  SUM(CASE WHEN pl.status = 'success' THEN 1 ELSE 0 END) AS success_count,
  SUM(CASE WHEN pl.status != 'success' THEN 1 ELSE 0 END) AS fail_count,
  ROUND(100.0 * SUM(CASE WHEN pl.status = 'success' THEN 1 ELSE 0 END) / COUNT(*), 1) AS success_rate_pct,
  ROUND(AVG(CASE WHEN pl.status = 'success' THEN pl.latency_ms END)) AS avg_latency_ms,
  ROUND(MIN(CASE WHEN pl.status = 'success' THEN pl.latency_ms END)) AS min_latency_ms,
  ROUND(MAX(CASE WHEN pl.status = 'success' THEN pl.latency_ms END)) AS max_latency_ms
FROM proxy_logs pl
JOIN route_channels rc ON pl.channel_id = rc.id
JOIN accounts a ON rc.account_id = a.id
JOIN sites s ON a.site_id = s.id
WHERE pl.created_at >= datetime('now', '-24 hours')
GROUP BY s.id, s.name
ORDER BY avg_latency_ms ASC;

-- ============================================================
-- 2. 各站点 P50/P90/P99 延迟分位数
-- ============================================================
SELECT '=== 2. 站点延迟分位数 ===' AS section;
WITH ranked AS (
  SELECT
    s.id AS site_id,
    s.name AS site_name,
    pl.latency_ms,
    ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY pl.latency_ms) AS rn,
    COUNT(*) OVER (PARTITION BY s.id) AS cnt
  FROM proxy_logs pl
  JOIN route_channels rc ON pl.channel_id = rc.id
  JOIN accounts a ON rc.account_id = a.id
  JOIN sites s ON a.site_id = s.id
  WHERE pl.status = 'success'
    AND pl.created_at >= datetime('now', '-24 hours')
)
SELECT
  site_name,
  cnt AS samples,
  MAX(CASE WHEN rn = CAST(cnt * 0.5 AS INTEGER) + 1 THEN latency_ms END) AS p50_ms,
  MAX(CASE WHEN rn = CAST(cnt * 0.9 AS INTEGER) + 1 THEN latency_ms END) AS p90_ms,
  MAX(CASE WHEN rn = CAST(cnt * 0.99 AS INTEGER) + 1 THEN latency_ms END) AS p99_ms
FROM ranked
GROUP BY site_id, site_name
HAVING cnt >= 3
ORDER BY p50_ms ASC;

-- ============================================================
-- 3. 模型×站点延迟矩阵（哪个模型在哪个站点最慢）
-- ============================================================
SELECT '=== 3. 模型×站点延迟矩阵 ===' AS section;
SELECT
  s.name AS site_name,
  pl.model_requested,
  COUNT(*) AS calls,
  ROUND(AVG(CASE WHEN pl.status = 'success' THEN pl.latency_ms END)) AS avg_latency_ms,
  ROUND(100.0 * SUM(CASE WHEN pl.status = 'success' THEN 1 ELSE 0 END) / COUNT(*), 1) AS success_rate_pct
FROM proxy_logs pl
JOIN route_channels rc ON pl.channel_id = rc.id
JOIN accounts a ON rc.account_id = a.id
JOIN sites s ON a.site_id = s.id
WHERE pl.created_at >= datetime('now', '-24 hours')
GROUP BY s.id, s.name, pl.model_requested
HAVING calls >= 2
ORDER BY avg_latency_ms DESC
LIMIT 50;

-- ============================================================
-- 4. 各站点错误率排行
-- ============================================================
SELECT '=== 4. 站点错误率排行 ===' AS section;
SELECT
  s.name AS site_name,
  s.id AS site_id,
  COUNT(*) AS total_calls,
  SUM(CASE WHEN pl.status != 'success' THEN 1 ELSE 0 END) AS errors,
  ROUND(100.0 * SUM(CASE WHEN pl.status != 'success' THEN 1 ELSE 0 END) / COUNT(*), 1) AS error_rate_pct,
  GROUP_CONCAT(DISTINCT pl.http_status) AS error_http_statuses
FROM proxy_logs pl
JOIN route_channels rc ON pl.channel_id = rc.id
JOIN accounts a ON rc.account_id = a.id
JOIN sites s ON a.site_id = s.id
WHERE pl.created_at >= datetime('now', '-24 hours')
GROUP BY s.id, s.name
HAVING error_rate_pct > 0
ORDER BY error_rate_pct DESC;

-- ============================================================
-- 5. 错误类型分布
-- ============================================================
SELECT '=== 5. 错误类型分布 ===' AS section;
SELECT
  s.name AS site_name,
  pl.http_status,
  CASE
    WHEN pl.http_status >= 500 THEN '5xx_server'
    WHEN pl.http_status = 429 THEN '429_ratelimit'
    WHEN pl.http_status IN (401, 403) THEN 'auth_error'
    WHEN pl.http_status >= 400 THEN '4xx_client'
    ELSE 'other'
  END AS error_category,
  COUNT(*) AS count,
  SUBSTR(pl.error_message, 1, 120) AS sample_error
FROM proxy_logs pl
JOIN route_channels rc ON pl.channel_id = rc.id
JOIN accounts a ON rc.account_id = a.id
JOIN sites s ON a.site_id = s.id
WHERE pl.status != 'success'
  AND pl.created_at >= datetime('now', '-24 hours')
GROUP BY s.id, s.name, pl.http_status
ORDER BY count DESC
LIMIT 40;

-- ============================================================
-- 6. 连续失败渠道（需要关注的）
-- ============================================================
SELECT '=== 6. 连续失败渠道 ===' AS section;
SELECT
  rc.id AS channel_id,
  s.name AS site_name,
  a.username,
  rc.fail_count,
  rc.success_count,
  rc.consecutive_fail_count,
  rc.cooldown_level,
  rc.cooldown_until,
  rc.last_fail_at,
  ROUND(CAST(rc.total_latency_ms AS REAL) / NULLIF(rc.success_count, 0)) AS avg_latency_ms,
  CASE WHEN rc.cooldown_until > datetime('now') THEN 'COOLING' ELSE 'ACTIVE' END AS state
FROM route_channels rc
JOIN accounts a ON rc.account_id = a.id
JOIN sites s ON a.site_id = s.id
WHERE rc.enabled = 1
  AND rc.fail_count > 0
ORDER BY rc.consecutive_fail_count DESC, rc.fail_count DESC
LIMIT 30;

-- ============================================================
-- 7. 站点重试消耗
-- ============================================================
SELECT '=== 7. 站点重试消耗 ===' AS section;
SELECT
  s.name AS site_name,
  SUM(pl.retry_count) AS total_retries,
  COUNT(*) AS total_requests,
  ROUND(1.0 * SUM(pl.retry_count) / COUNT(*), 2) AS avg_retries_per_req,
  SUM(CASE WHEN pl.retry_count > 0 THEN 1 ELSE 0 END) AS requests_with_retry
FROM proxy_logs pl
JOIN route_channels rc ON pl.channel_id = rc.id
JOIN accounts a ON rc.account_id = a.id
JOIN sites s ON a.site_id = s.id
WHERE pl.created_at >= datetime('now', '-24 hours')
GROUP BY s.id, s.name
HAVING total_retries > 0
ORDER BY total_retries DESC;

-- ============================================================
-- 8. 渠道状态总览（按站点聚合）
-- ============================================================
SELECT '=== 8. 渠道状态总览 ===' AS section;
SELECT
  s.name AS site_name,
  s.status AS site_status,
  s.global_weight,
  COUNT(rc.id) AS total_channels,
  SUM(CASE WHEN rc.enabled = 1 THEN 1 ELSE 0 END) AS enabled_channels,
  SUM(CASE WHEN rc.cooldown_until > datetime('now') THEN 1 ELSE 0 END) AS cooling_channels,
  SUM(rc.success_count) AS total_success,
  SUM(rc.fail_count) AS total_fail,
  ROUND(100.0 * SUM(rc.success_count) / NULLIF(SUM(rc.success_count) + SUM(rc.fail_count), 0), 1) AS success_rate_pct,
  ROUND(CAST(SUM(rc.total_latency_ms) AS REAL) / NULLIF(SUM(rc.success_count), 0)) AS avg_latency_ms
FROM sites s
LEFT JOIN accounts a ON s.id = a.site_id
LEFT JOIN route_channels rc ON a.id = rc.account_id
GROUP BY s.id, s.name, s.status, s.global_weight
ORDER BY success_rate_pct ASC;

-- ============================================================
-- 9. 运行时健康状态 JSON
-- ============================================================
SELECT '=== 9. 运行时健康状态 ===' AS section;
SELECT value FROM settings WHERE key = 'token_router_site_runtime_health_v1';

-- ============================================================
-- 10. 站点综合健康评分（低分=更差）
-- ============================================================
SELECT '=== 10. 站点综合健康评分 ===' AS section;
SELECT
  s.name AS site_name,
  s.global_weight,
  COUNT(pl.id) AS total_calls,
  ROUND(100.0 * SUM(CASE WHEN pl.status = 'success' THEN 1 ELSE 0 END) / COUNT(*), 1) AS success_rate,
  ROUND(AVG(CASE WHEN pl.status = 'success' THEN pl.latency_ms END)) AS avg_latency,
  SUM(pl.retry_count) AS total_retries,
  ROUND(
    (100.0 * SUM(CASE WHEN pl.status = 'success' THEN 1 ELSE 0 END) / COUNT(*))
    * (1.0 / (1.0 + COALESCE(AVG(CASE WHEN pl.status = 'success' THEN pl.latency_ms END), 10000) / 1000.0))
    * (1.0 / (1.0 + 1.0 * SUM(pl.retry_count) / COUNT(*))),
    2
  ) AS health_score
FROM proxy_logs pl
JOIN route_channels rc ON pl.channel_id = rc.id
JOIN accounts a ON rc.account_id = a.id
JOIN sites s ON a.site_id = s.id
WHERE pl.created_at >= datetime('now', '-24 hours')
GROUP BY s.id, s.name, s.global_weight
ORDER BY health_score ASC;

-- ============================================================
-- 11. 每小时趋势（延迟+错误）
-- ============================================================
SELECT '=== 11. 每小时趋势 ===' AS section;
SELECT
  s.name AS site_name,
  strftime('%Y-%m-%d %H:00', pl.created_at) AS hour_bucket,
  COUNT(*) AS calls,
  ROUND(AVG(CASE WHEN pl.status = 'success' THEN pl.latency_ms END)) AS avg_latency_ms,
  SUM(CASE WHEN pl.status != 'success' THEN 1 ELSE 0 END) AS errors
FROM proxy_logs pl
JOIN route_channels rc ON pl.channel_id = rc.id
JOIN accounts a ON rc.account_id = a.id
JOIN sites s ON a.site_id = s.id
WHERE pl.created_at >= datetime('now', '-24 hours')
GROUP BY s.id, s.name, hour_bucket
ORDER BY s.name, hour_bucket;
