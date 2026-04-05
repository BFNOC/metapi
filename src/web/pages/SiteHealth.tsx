import React, { useEffect, useMemo, useState } from 'react';
import { api, type SiteHealthFailureSummary, type SiteHealthState, type SiteHealthStateRow, type SiteHealthSuccessSummary } from '../api.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import ModelProbeModal from '../components/ModelProbeModal.js';
import ResponsiveFilterPanel from '../components/ResponsiveFilterPanel.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { tr } from '../i18n.js';

function formatDateTime(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function renderStateLabel(state: SiteHealthState): string {
  switch (state) {
    case 'quarantined':
      return '隔离中';
    case 'penalized':
      return '降权中';
    case 'recovering':
      return '恢复中';
    case 'active':
    default:
      return '正常';
  }
}

function renderStateBadgeClass(state: SiteHealthState): string {
  switch (state) {
    case 'quarantined':
      return 'badge-error';
    case 'penalized':
      return 'badge-warning';
    case 'recovering':
      return 'badge-info';
    case 'active':
    default:
      return 'badge-success';
  }
}

function renderProbePolicyLabel(policy: SiteHealthStateRow['probePolicy']): string {
  switch (policy) {
    case 'manual_only':
      return '仅手动验证';
    case 'forbid_batch_probe':
      return '禁止批量探活';
    case 'allow_recovery_probe':
    default:
      return '允许恢复探活';
  }
}

function renderProbePolicyBadgeClass(policy: SiteHealthStateRow['probePolicy']): string {
  switch (policy) {
    case 'manual_only':
      return 'badge-warning';
    case 'forbid_batch_probe':
      return 'badge-error';
    case 'allow_recovery_probe':
    default:
      return 'badge-info';
  }
}

function describeCooldown(row: SiteHealthStateRow): string {
  const cooldownCount = row.cooldownSummary.activeChannelCooldownCount;
  const affectedRouteCount = row.cooldownSummary.affectedRouteCount;
  const earliestCooldownUntil = row.cooldownSummary.earliestCooldownUntil;
  if (cooldownCount <= 0) return '当前无冷却通道';
  return `冷却通道 ${cooldownCount}${affectedRouteCount > 0 ? ` / 影响路由 ${affectedRouteCount}` : ''}${earliestCooldownUntil ? ` / 最早恢复 ${formatDateTime(earliestCooldownUntil)}` : ''}`;
}

function describeRecentFailure(summary: SiteHealthFailureSummary | string | null): string {
  if (!summary) return '';
  if (typeof summary === 'string') return summary;
  const prefix = [summary.kind || null, summary.httpStatus ? `HTTP ${summary.httpStatus}` : null]
    .filter(Boolean)
    .join(' / ');
  return [prefix, summary.message || ''].filter(Boolean).join('：');
}

function describeRecentSuccess(summary: SiteHealthSuccessSummary | null): string {
  if (!summary) return '';
  return [
    summary.modelName || null,
    summary.httpStatus ? `HTTP ${summary.httpStatus}` : null,
    typeof summary.firstByteLatencyMs === 'number' ? `TTFT ${Math.round(summary.firstByteLatencyMs)}ms` : null,
    typeof summary.latencyMs === 'number' ? `总耗时 ${Math.round(summary.latencyMs)}ms` : null,
  ].filter(Boolean).join(' / ');
}

function describeRuntime(row: SiteHealthStateRow): string {
  const parts = [`penalty ${row.penaltyScore.toFixed(2)}`];
  if (row.breakerOpen) parts.push('breaker open');
  if (typeof row.latencyEmaMs === 'number') parts.push(`延迟 ${Math.round(row.latencyEmaMs)}ms`);
  return parts.join(' / ');
}

function renderEventCell(options: {
  time: string | null;
  summary: string;
  emptySummaryLabel: string;
}) {
  const timeLabel = formatDateTime(options.time);
  const summaryLabel = options.summary || options.emptySummaryLabel;
  const tooltip = [
    options.time ? `时间：${timeLabel}` : null,
    summaryLabel ? `详情：${summaryLabel}` : null,
  ].filter(Boolean).join(' ｜ ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>{timeLabel}</div>
      <div
        data-tooltip={tooltip || undefined}
        data-tooltip-align="start"
        tabIndex={tooltip ? 0 : undefined}
        style={{
          fontSize: 12,
          color: 'var(--color-text-primary)',
          whiteSpace: 'normal',
          wordBreak: 'break-word',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          lineHeight: 1.45,
          cursor: tooltip ? 'help' : 'default',
        }}
      >
        {summaryLabel}
      </div>
    </div>
  );
}

export default function SiteHealth() {
  const isMobile = useIsMobile();
  const [rows, setRows] = useState<SiteHealthStateRow[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | SiteHealthState>('all');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [probeTarget, setProbeTarget] = useState<null | { siteId: number; siteName: string }>(null);

  const loadRows = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.getSiteHealthStates();
      setEnabled(response.enabled !== false);
      setRows(response.items);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '加载站点健康状态失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRows();
  }, []);

  const filteredRows = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (stateFilter !== 'all' && row.state !== stateFilter) return false;
      if (!keyword) return true;
      return row.siteName.toLowerCase().includes(keyword)
        || (row.siteUrl || '').toLowerCase().includes(keyword)
        || describeRecentFailure(row.recentFailureSummary).toLowerCase().includes(keyword)
        || describeRecentSuccess(row.recentSuccessSummary).toLowerCase().includes(keyword);
    });
  }, [rows, search, stateFilter]);

  const summary = useMemo(() => rows.reduce((acc, row) => {
    acc.total += 1;
    acc[row.state] += 1;
    acc.cooldownSites += row.cooldownSummary.activeChannelCooldownCount > 0 ? 1 : 0;
    acc.cooldownChannels += row.cooldownSummary.activeChannelCooldownCount;
    return acc;
  }, {
    total: 0,
    active: 0,
    penalized: 0,
    quarantined: 0,
    recovering: 0,
    cooldownSites: 0,
    cooldownChannels: 0,
  }), [rows]);

  const renderActions = (row: SiteHealthStateRow) => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <a className="btn btn-link btn-link-info" href={`/logs?siteId=${row.siteId}`}>{tr('查看日志')}</a>
      <button
        type="button"
        className="btn btn-link btn-link-primary"
        disabled={row.probePolicy === 'forbid_batch_probe'}
        onClick={() => setProbeTarget({ siteId: row.siteId, siteName: row.siteName })}
      >
        {tr('探活')}
      </button>
    </div>
  );

  const filters = (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
      <div className="toolbar-search" style={{ minWidth: 240, flex: '1 1 260px' }}>
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={tr('搜索站点名 / URL / 最近失败')}
        />
      </div>
      <select
        value={stateFilter}
        onChange={(event) => setStateFilter(event.target.value as 'all' | SiteHealthState)}
        style={{
          minWidth: 150,
          height: 36,
          padding: '0 12px',
          borderRadius: 10,
          border: '1px solid var(--color-border)',
          background: 'var(--color-bg-card)',
          color: 'var(--color-text-primary)',
          fontSize: 13,
        }}
      >
        <option value="all">{tr('全部状态')}</option>
        <option value="active">{tr('正常')}</option>
        <option value="penalized">{tr('降权中')}</option>
        <option value="quarantined">{tr('隔离中')}</option>
        <option value="recovering">{tr('恢复中')}</option>
      </select>
      <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-muted)' }}>
        {tr('当前展示')} {filteredRows.length} / {rows.length} {tr('个站点')}
      </div>
    </div>
  );

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h2 className="page-title">{tr('站点健康')}</h2>
          <div className="page-subtitle" style={{ color: 'var(--color-text-secondary)', marginTop: 6, maxWidth: 720, lineHeight: 1.7 }}>
            {tr('真实流量驱动的站点级运行健康摘要，用于沉底、恢复和手动验证观察。')}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }} onClick={() => void loadRows()}>
            {loading ? <><span className="spinner spinner-sm" /> {tr('刷新中...')}</> : tr('刷新')}
          </button>
        </div>
      </div>

      <ResponsiveFilterPanel
        isMobile={isMobile}
        mobileOpen={mobileFiltersOpen}
        onMobileOpen={() => setMobileFiltersOpen(true)}
        onMobileClose={() => setMobileFiltersOpen(false)}
        mobileTitle={tr('筛选站点健康')}
        mobileContent={filters}
        desktopContent={<div className="card animate-slide-up stagger-1" style={{ padding: 14, marginBottom: 12 }}>{filters}</div>}
      />

      {error ? <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div> : null}
      {!enabled ? (
        <div className="card animate-slide-up" style={{ padding: 20, marginBottom: 12 }}>
          <strong>站点健康信号已关闭</strong>
        </div>
      ) : null}

      {enabled && !loading ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div className="stat-summary-card stat-summary-blue animate-slide-up stagger-2">
            <div className="stat-summary-card-label">{tr('总站点')}</div>
            <div className="stat-summary-card-value">{summary.total}</div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.88 }}>{tr('正常')} {summary.active} · {tr('恢复中')} {summary.recovering}</div>
          </div>
          <div className="stat-summary-card stat-summary-orange animate-slide-up stagger-3">
            <div className="stat-summary-card-label">{tr('隔离中')}</div>
            <div className="stat-summary-card-value">{summary.quarantined}</div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.88 }}>{tr('需优先沉底处理')}</div>
          </div>
          <div className="stat-summary-card stat-summary-purple animate-slide-up stagger-4">
            <div className="stat-summary-card-label">{tr('降权中')}</div>
            <div className="stat-summary-card-value">{summary.penalized}</div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.88 }}>{tr('等待失败影响消退')}</div>
          </div>
          <div className="stat-summary-card stat-summary-green animate-slide-up stagger-5">
            <div className="stat-summary-card-label">{tr('冷却通道')}</div>
            <div className="stat-summary-card-value">{summary.cooldownChannels}</div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.88 }}>{tr('涉及站点')} {summary.cooldownSites}</div>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="card animate-slide-up stagger-6" style={{ padding: 20 }}>
          <div className="skeleton" style={{ height: 18, width: 220, marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 18, width: '100%', marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 18, width: '72%' }} />
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="card animate-slide-up stagger-6" style={{ padding: 28 }}>
          <div className="empty-state" style={{ padding: 0 }}>
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V7a2 2 0 012-2h3l2-2h5a2 2 0 012 2v14a2 2 0 01-2 2z" />
            </svg>
            <div className="empty-state-title">{tr('暂无站点健康数据')}</div>
            <div className="empty-state-desc">{tr('当前筛选条件下没有可展示的站点健康记录。')}</div>
          </div>
        </div>
      ) : isMobile ? (
        <div className="mobile-card-list">
          {filteredRows.map((row) => (
            <MobileCard
              key={row.siteId}
              title={row.siteName}
              subtitle={row.siteUrl || '-'}
              headerActions={<span className={`badge ${renderStateBadgeClass(row.state)}`}>{renderStateLabel(row.state)}</span>}
              footerActions={renderActions(row)}
            >
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 2 }}>
                <span className="badge badge-muted">{row.siteStatus}</span>
                <span className={`badge ${renderProbePolicyBadgeClass(row.probePolicy)}`}>{renderProbePolicyLabel(row.probePolicy)}</span>
                <span className={`badge ${row.unhealthyModelCount > 0 ? 'badge-warning' : 'badge-muted'}`}>
                  {tr('异常模型')} {row.unhealthyModelCount}/{row.activeModelCount}
                </span>
              </div>
              <MobileField label={tr('运行状态')} value={describeRuntime(row)} stacked />
              <MobileField
                label={tr('最近成功')}
                value={renderEventCell({
                  time: row.recentSuccessSummary?.occurredAt ?? row.lastSuccessAt,
                  summary: describeRecentSuccess(row.recentSuccessSummary),
                  emptySummaryLabel: '最近成功请求已记录，但暂无摘要',
                })}
                stacked
              />
              <MobileField
                label={tr('最近失败')}
                value={renderEventCell({
                  time: row.recentFailureSummary?.occurredAt ?? row.lastFailureAt,
                  summary: describeRecentFailure(row.recentFailureSummary),
                  emptySummaryLabel: '失败详情缺失',
                })}
                stacked
              />
              <MobileField label={tr('冷却')} value={describeCooldown(row)} stacked />
            </MobileCard>
          ))}
        </div>
      ) : (
        <div className="card animate-slide-up stagger-6" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <colgroup>
              <col style={{ width: '28%' }} />
              <col style={{ width: 210 }} />
              <col style={{ width: 180 }} />
              <col style={{ width: '22%' }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: 140 }} />
            </colgroup>
            <thead>
              <tr>
                <th>{tr('站点')}</th>
                <th>{tr('状态')}</th>
                <th>{tr('最近成功')}</th>
                <th>{tr('最近失败')}</th>
                <th>{tr('冷却')}</th>
                <th>{tr('动作')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr key={row.siteId}>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>{row.siteName}</strong>
                        {row.platform ? <span className="badge badge-muted">{row.platform}</span> : null}
                      </div>
                      <span style={{ color: 'var(--color-text-secondary)', fontSize: 12, wordBreak: 'break-all', whiteSpace: 'normal' }}>{row.siteUrl || '-'}</span>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span className="badge badge-muted">{row.siteStatus}</span>
                        <span className={`badge ${renderProbePolicyBadgeClass(row.probePolicy)}`}>{renderProbePolicyLabel(row.probePolicy)}</span>
                        <span className={`badge ${row.unhealthyModelCount > 0 ? 'badge-warning' : 'badge-muted'}`}>
                          {tr('异常模型')} {row.unhealthyModelCount}/{row.activeModelCount}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                      <span className={`badge ${renderStateBadgeClass(row.state)}`}>{renderStateLabel(row.state)}</span>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span className="badge badge-muted">penalty {row.penaltyScore.toFixed(2)}</span>
                        {row.breakerOpen ? <span className="badge badge-error">breaker open</span> : null}
                        {typeof row.latencyEmaMs === 'number' ? <span className="badge badge-info">{Math.round(row.latencyEmaMs)}ms</span> : null}
                      </div>
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {renderEventCell({
                      time: row.recentSuccessSummary?.occurredAt ?? row.lastSuccessAt,
                      summary: describeRecentSuccess(row.recentSuccessSummary),
                      emptySummaryLabel: '最近成功请求已记录，但暂无摘要',
                    })}
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {renderEventCell({
                        time: row.recentFailureSummary?.occurredAt ?? row.lastFailureAt,
                        summary: describeRecentFailure(row.recentFailureSummary),
                        emptySummaryLabel: '失败详情缺失',
                      })}
                      {row.severeFailureCount > 0 ? <span className="badge badge-warning">{tr('严重失败')} {row.severeFailureCount}</span> : null}
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>{describeCooldown(row)}</td>
                  <td style={{ textAlign: 'right' }}>{renderActions(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ModelProbeModal
        open={Boolean(probeTarget)}
        onClose={() => { setProbeTarget(null); void loadRows(); }}
        siteId={probeTarget?.siteId || 0}
        siteName={probeTarget?.siteName || ''}
      />
    </div>
  );
}
