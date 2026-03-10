import type { CSSProperties } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import ModernSelect from '../../components/ModernSelect.js';
import type { SortableChannelRowProps } from './types.js';
import { getChannelDecisionState, getPriorityTagStyle, getProbabilityColor } from './utils.js';

export function SortableChannelRow({
  channel,
  decisionCandidate,
  isExactRoute,
  loadingDecision,
  isSavingPriority,
  tokenOptions,
  activeTokenId,
  isUpdatingToken,
  onTokenDraftChange,
  onSaveToken,
  onDeleteChannel,
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
    disabled: isSavingPriority,
  });

  const rowStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.72 : 1,
    zIndex: isDragging ? 10 : 1,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderLeft: '2px solid var(--color-primary)',
    borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
    background: isDragging ? 'rgba(59,130,246,0.08)' : 'rgba(79,70,229,0.02)',
    boxShadow: isDragging ? 'var(--shadow-sm)' : 'none',
  };

  const decisionState = getChannelDecisionState(decisionCandidate, channel, isExactRoute, loadingDecision);

  return (
    <div ref={setNodeRef} style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, flexWrap: 'wrap', minWidth: 0 }}>
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          disabled={isSavingPriority}
          className="btn btn-ghost"
          style={{
            width: 22,
            minWidth: 22,
            height: 22,
            padding: 0,
            border: '1px solid var(--color-border-light)',
            color: 'var(--color-text-muted)',
            cursor: isSavingPriority ? 'not-allowed' : 'grab',
          }}
          data-tooltip="拖拽调整优先级"
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
            background: 'color-mix(in srgb, var(--color-info) 15%, transparent)',
            color: 'var(--color-info)',
          }}
        >
          {channel.token?.name || '默认令牌'}
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginTop: 4 }}>
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
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ minWidth: 150, flex: 1 }}>
          <ModernSelect
            size="sm"
            value={String(activeTokenId || 0)}
            onChange={(nextValue) => onTokenDraftChange(channel.id, Number.parseInt(nextValue, 10) || 0)}
            disabled={isUpdatingToken}
            options={[
              { value: '0', label: '默认令牌' },
              ...tokenOptions.map((token) => ({
                value: String(token.id),
                label: `${token.name}${token.isDefault ? '（默认）' : ''}`,
              })),
            ]}
            placeholder="默认令牌"
          />
        </div>
        <button
          onClick={onSaveToken}
          disabled={isUpdatingToken}
          className="btn btn-link btn-link-info"
        >
          {isUpdatingToken ? <span className="spinner spinner-sm" /> : '改令牌'}
        </button>
      </div>

      <button
        onClick={onDeleteChannel}
        className="btn btn-link btn-link-danger"
      >
        移除
      </button>
    </div>
  );
}
