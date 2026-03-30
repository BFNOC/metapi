import { useState, type CSSProperties } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { SortableChannelRowProps } from './types.js';
import {
  describeTokenBinding,
  resolveTokenBindingConnectionMode,
} from './tokenBindingPresentation.js';
import { getChannelDecisionState, getPriorityTagStyle, getProbabilityColor } from './utils.js';
import { ChannelSettingsPanel } from './ChannelSettingsPanel.js';
import type { RouteDecisionCandidate } from '../../../shared/tokenRouteContract.js';

function RuntimeHealthBadges({ health }: { health: RouteDecisionCandidate['runtimeHealth'] }) {
  if (!health) return null;
  const badges: JSX.Element[] = [];

  if (health.globalBreakerOpen || health.modelBreakerOpen) {
    const label = health.globalBreakerOpen ? '站点熔断' : '模型熔断';
    badges.push(
      <span
        key="breaker"
        className="badge"
        style={{
          fontSize: 10,
          background: 'color-mix(in srgb, var(--color-danger) 15%, transparent)',
          color: 'var(--color-danger)',
        }}
        data-tooltip={`${label}中 — 错误连续触发熔断保护，暂时不会被选中`}
      >
        🔴 {label}
      </span>,
    );
  }

  const multiplier = Number(health.combinedMultiplier) || 0;
  const penalty = Number(health.penaltyScore) || 0;

  if (multiplier < 0.5 && !health.globalBreakerOpen && !health.modelBreakerOpen) {
    badges.push(
      <span
        key="multiplier"
        className="badge"
        style={{
          fontSize: 10,
          background: 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
          color: 'var(--color-warning)',
        }}
        data-tooltip={`错误健康乘子 ×${multiplier.toFixed(2)}（仅错误驱动：penalty=${penalty.toFixed(1)}）`}
      >
        ⚠ 降权 ×{multiplier.toFixed(2)}
      </span>,
    );
  }

  if (health.latencyEmaMs != null) {
    const latencyText = health.latencyEmaMs >= 1000
      ? `${(health.latencyEmaMs / 1000).toFixed(1)}s`
      : `${Math.round(health.latencyEmaMs)}ms`;
    badges.push(
      <span
        key="latency"
        className="badge badge-muted"
        style={{ fontSize: 10 }}
        data-tooltip={`延迟 EMA ${Math.round(health.latencyEmaMs)}ms — 仅展示，不参与路由决策`}
      >
        ⏱ {latencyText}
      </span>,
    );
  }

  return badges.length > 0 ? <>{badges}</> : null;
}

export function SortableChannelRow({
  channel,
  decisionCandidate,
  isExactRoute,
  loadingDecision,
  isSavingPriority,
  readOnly = false,
  mobile = false,
  tokenOptions,
  activeTokenId,
  isUpdatingToken,
  onSaveSettings,
  onDeleteChannel,
  onToggleEnabled,
  onSiteBlockModel,
}: SortableChannelRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: channel.id,
    disabled: isSavingPriority || readOnly,
  });

  const rowStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.72 : channel.enabled === false ? 0.5 : 1,
    zIndex: isDragging ? 10 : 1,
    display: 'grid',
    gridTemplateColumns: readOnly || mobile ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) auto auto auto',
    alignItems: mobile ? 'stretch' : 'center',
    gap: 8,
    padding: mobile ? '10px 12px' : '8px 12px',
    borderLeft: '2px solid var(--color-primary)',
    borderBottom: '1px solid var(--color-border)',
    borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
    background: isDragging ? 'rgba(59,130,246,0.08)' : 'var(--color-bg-card, rgba(79,70,229,0.02))',
    boxShadow: isDragging ? 'var(--shadow-sm)' : 'none',
  };

  const decisionState = getChannelDecisionState(decisionCandidate, channel, isExactRoute, loadingDecision);
  const tokenBinding = describeTokenBinding(
    tokenOptions,
    activeTokenId,
    channel.token?.name ?? null,
    {
      connectionMode: resolveTokenBindingConnectionMode(channel.account),
      accountName: channel.account?.username || `account-${channel.accountId}`,
    },
  );

  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);

  // Shared action buttons rendered inside ChannelSettingsPanel
  const actionButtons = (
    <>
      <button
        onClick={() => onToggleEnabled(channel.enabled === false)}
        className={`btn btn-link ${channel.enabled === false ? 'btn-link-info' : 'btn-link-warning'}`}
        data-tooltip={channel.enabled === false ? '启用此通道' : '禁用此通道'}
      >
        {channel.enabled === false ? '启用' : '禁用'}
      </button>

      {onSiteBlockModel && channel.site?.id ? (
        <button
          onClick={onSiteBlockModel}
          className="btn btn-link btn-link-warning"
          data-tooltip={`将此模型加入站点「${channel.site?.name || '未知'}」的禁用列表，rebuild 后该站点的此模型通道将不再生成`}
        >
          站点屏蔽
        </button>
      ) : null}

      <button
        onClick={onDeleteChannel}
        className="btn btn-link btn-link-danger"
      >
        移除
      </button>
    </>
  );

  if (mobile) {
    return (
      <div ref={setNodeRef} style={{ ...rowStyle, display: 'block' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            disabled={isSavingPriority || readOnly}
            className="btn btn-ghost"
            style={{
              width: 22,
              minWidth: 22,
              height: 22,
              padding: 0,
              border: '1px solid var(--color-border-light)',
              color: 'var(--color-text-muted)',
              cursor: isSavingPriority || readOnly ? 'not-allowed' : 'grab',
              opacity: readOnly ? 0.65 : 1,
              marginTop: 2,
            }}
            data-tooltip={readOnly ? '来源群组继承通道优先级，不能在这里拖动' : '拖拽调整优先级'}
            aria-label="拖拽调整优先级"
          >
            <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12" aria-hidden>
              <circle cx="3" cy="2" r="1" />
              <circle cx="9" cy="2" r="1" />
              <circle cx="3" cy="6" r="1" />
              <circle cx="9" cy="6" r="1" />
              <circle cx="3" cy="10" r="1" />
              <circle cx="9" cy="10" r="1" />
            </svg>
          </button>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span
                className="badge"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.1,
                  ...getPriorityTagStyle(channel.priority ?? 0),
                }}
              >
                P{channel.priority ?? 0}
              </span>

              <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: 14, minWidth: 0 }}>
                {channel.account?.username || `account-${channel.accountId}`}
              </span>

              <span className="badge badge-muted" style={{ fontSize: 10 }}>
                {channel.site?.name || 'unknown'}
              </span>

              <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
                成功/失败 <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{channel.successCount || 0}</span>
                <span style={{ color: 'var(--color-text-muted)', margin: '0 2px' }}>/</span>
                <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>{channel.failCount || 0}</span>
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span
                className="badge"
                style={{
                  fontSize: 10,
                  background: tokenBinding.badgeTone === 'info'
                    ? 'color-mix(in srgb, var(--color-info) 15%, transparent)'
                    : 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
                  color: tokenBinding.badgeTone === 'info' ? 'var(--color-info)' : 'var(--color-warning)',
                }}
              >
                {tokenBinding.bindingModeLabel}
              </span>

              <span
                className="badge"
                style={{
                  fontSize: 10,
                  background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)',
                  color: 'var(--color-primary)',
                  maxWidth: 220,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                data-tooltip={`当前生效：${tokenBinding.effectiveTokenName}`}
              >
                当前生效：{tokenBinding.effectiveTokenName}
              </span>

              {channel.sourceModel ? (
                <span className="badge badge-info" style={{ fontSize: 10 }}>
                  {channel.sourceModel}
                </span>
              ) : null}

              {channel.manualOverride ? (
                <span
                  className="badge badge-warning"
                  style={{ fontSize: 10 }}
                  data-tooltip="该通道由用户手动添加，而非系统自动生成"
                >
                  手动配置
                </span>
              ) : null}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>选中概率</span>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 120 }}>
                <div
                  data-tooltip={decisionState.probability <= 0 ? decisionState.reasonText : undefined}
                  style={{
                    width: 80,
                    height: 6,
                    background: 'var(--color-border)',
                    borderRadius: 999,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(0, Math.min(100, decisionState.probability))}%`,
                      height: '100%',
                      background: getProbabilityColor(decisionState.probability),
                      borderRadius: 999,
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
                <span
                  data-tooltip={decisionState.probability <= 0 ? decisionState.reasonText : undefined}
                  style={{
                    fontSize: 11,
                    color: decisionState.probability > 0 ? 'var(--color-text-secondary)' : decisionState.reasonColor,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {decisionState.probability.toFixed(1)}%
                </span>
              </div>

              <RuntimeHealthBadges health={decisionCandidate?.runtimeHealth} />

              {!readOnly && (
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => setMobileDetailsOpen((current) => !current)}
                  style={{ marginLeft: 'auto' }}
                >
                  {mobileDetailsOpen ? '收起配置' : '配置通道'}
                </button>
              )}
            </div>

            {!readOnly && mobileDetailsOpen && (
              <div style={{ paddingTop: 8, borderTop: '1px solid var(--color-border-light)' }}>
                <ChannelSettingsPanel
                  channel={channel}
                  tokenOptions={tokenOptions}
                  activeTokenId={activeTokenId}
                  isUpdatingToken={isUpdatingToken}
                  compact
                  onSave={onSaveSettings}
                  actions={actionButtons}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={rowStyle}>
      <div style={{ display: 'flex', alignItems: mobile ? 'stretch' : 'center', flexDirection: mobile ? 'column' : 'row', gap: 10, fontSize: 13, flexWrap: 'wrap', minWidth: 0 }}>
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          disabled={isSavingPriority || readOnly}
          className="btn btn-ghost"
          style={{
            width: 22,
            minWidth: 22,
            height: 22,
            padding: 0,
            border: '1px solid var(--color-border-light)',
            color: 'var(--color-text-muted)',
            cursor: isSavingPriority || readOnly ? 'not-allowed' : 'grab',
            opacity: readOnly ? 0.65 : 1,
          }}
          data-tooltip={readOnly ? '来源群组继承通道优先级，不能在这里拖动' : '拖拽调整优先级'}
          aria-label="拖拽调整优先级"
        >
          <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12" aria-hidden>
            <circle cx="3" cy="2" r="1" />
            <circle cx="9" cy="2" r="1" />
            <circle cx="3" cy="6" r="1" />
            <circle cx="9" cy="6" r="1" />
            <circle cx="3" cy="10" r="1" />
            <circle cx="9" cy="10" r="1" />
          </svg>
        </button>

        <span
          className="badge"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.1,
            ...getPriorityTagStyle(channel.priority ?? 0),
          }}
        >
          P{channel.priority ?? 0}
        </span>

        <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
          {channel.account?.username || `account-${channel.accountId}`}
        </span>

        <span className="badge badge-muted" style={{ fontSize: 10 }}>
          {channel.site?.name || 'unknown'}
        </span>

        <span
          className="badge"
          style={{
            fontSize: 10,
            background: tokenBinding.badgeTone === 'info'
              ? 'color-mix(in srgb, var(--color-info) 15%, transparent)'
              : 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
            color: tokenBinding.badgeTone === 'info' ? 'var(--color-info)' : 'var(--color-warning)',
          }}
        >
          {tokenBinding.bindingModeLabel}
        </span>

        <span
          className="badge"
          style={{
            fontSize: 10,
            background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)',
            color: 'var(--color-primary)',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          data-tooltip={`当前生效：${tokenBinding.effectiveTokenName}`}
        >
          当前生效：{tokenBinding.effectiveTokenName}
        </span>

        {channel.sourceModel ? (
          <span className="badge badge-info" style={{ fontSize: 10 }}>
            {channel.sourceModel}
          </span>
        ) : null}

        {channel.manualOverride ? (
          <span
            className="badge badge-warning"
            style={{ fontSize: 10 }}
            data-tooltip="该通道由用户手动添加，而非系统自动生成"
          >
            手动配置
          </span>
        ) : null}

        {channel.enabled === false ? (
          <span className="badge badge-muted" style={{ fontSize: 10 }}>已禁用</span>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginTop: mobile ? 0 : 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>选中概率</span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 120 }}>
            <div
              data-tooltip={decisionState.probability <= 0 ? decisionState.reasonText : undefined}
              style={{
                width: 80,
                height: 6,
                background: 'var(--color-border)',
                borderRadius: 999,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, decisionState.probability))}%`,
                  height: '100%',
                  background: getProbabilityColor(decisionState.probability),
                  borderRadius: 999,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <span
              data-tooltip={decisionState.probability <= 0 ? decisionState.reasonText : undefined}
              style={{
                fontSize: 11,
                color: decisionState.probability > 0 ? 'var(--color-text-secondary)' : decisionState.reasonColor,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}
            >
              {decisionState.probability.toFixed(1)}%
            </span>
          </div>

          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>成功/失败</span>
          <span style={{ fontSize: 11 }}>
            <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{channel.successCount || 0}</span>
            <span style={{ color: 'var(--color-text-muted)', margin: '0 2px' }}>/</span>
            <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>{channel.failCount || 0}</span>
          </span>

          <RuntimeHealthBadges health={decisionCandidate?.runtimeHealth} />
        </div>
      </div>

      {!readOnly ? (
        <ChannelSettingsPanel
          channel={channel}
          tokenOptions={tokenOptions}
          activeTokenId={activeTokenId}
          isUpdatingToken={isUpdatingToken}
          compact={mobile}
          onSave={onSaveSettings}
          actions={actionButtons}
        />
      ) : null}
    </div>
  );
}
