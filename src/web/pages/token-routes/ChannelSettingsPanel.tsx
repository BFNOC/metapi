import { useState, useEffect, useRef, type ReactNode } from 'react';
import ModernSelect from '../../components/ModernSelect.js';
import type { RouteChannel, RouteTokenOption } from './types.js';
import {
  buildFixedTokenOptionDescription,
  buildFixedTokenOptionLabel,
  describeTokenBinding,
  resolveTokenBindingConnectionMode,
} from './tokenBindingPresentation.js';

export type ChannelSettingsPanelProps = {
  channel: RouteChannel;
  tokenOptions: RouteTokenOption[];
  activeTokenId: number;
  isUpdatingToken: boolean;
  disabled?: boolean;
  compact?: boolean;
  onSave: (channelId: number, updates: { tokenId?: number | null; priority?: number; weight?: number }) => void;
  /** Extra action buttons rendered after the save button */
  actions?: ReactNode;
};

export function ChannelSettingsPanel({
  channel,
  tokenOptions,
  activeTokenId,
  isUpdatingToken,
  disabled = false,
  compact = false,
  onSave,
  actions,
}: ChannelSettingsPanelProps) {
  // --- Draft state ---
  const [draftTokenId, setDraftTokenId] = useState<number>(activeTokenId || 0);
  const [draftPriority, setDraftPriority] = useState<number>(channel.priority ?? 0);
  const [draftWeight, setDraftWeight] = useState<number>(channel.weight ?? 10);

  // --- Dirty tracking ---
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());

  // --- Baseline refs (to detect external prop changes vs user edits) ---
  const baselineRef = useRef({ tokenId: activeTokenId || 0, priority: channel.priority ?? 0, weight: channel.weight ?? 10 });

  // --- Sync drafts when channel props change externally (e.g. after drag-and-drop) ---
  useEffect(() => {
    const prev = baselineRef.current;
    const nextPriority = channel.priority ?? 0;
    const nextWeight = channel.weight ?? 10;
    const nextTokenId = activeTokenId || 0;

    let changed = false;
    if (prev.priority !== nextPriority) {
      setDraftPriority(nextPriority);
      setDirtyFields((d) => { const n = new Set(d); n.delete('priority'); return n; });
      changed = true;
    }
    if (prev.weight !== nextWeight) {
      setDraftWeight(nextWeight);
      setDirtyFields((d) => { const n = new Set(d); n.delete('weight'); return n; });
      changed = true;
    }
    if (prev.tokenId !== nextTokenId) {
      setDraftTokenId(nextTokenId);
      setDirtyFields((d) => { const n = new Set(d); n.delete('tokenId'); return n; });
      changed = true;
    }
    if (changed) {
      baselineRef.current = { tokenId: nextTokenId, priority: nextPriority, weight: nextWeight };
    }
  }, [channel.priority, channel.weight, activeTokenId]);

  // --- Handlers ---
  const handleTokenChange = (nextValue: string) => {
    const val = Number.parseInt(nextValue, 10) || 0;
    setDraftTokenId(val);
    setDirtyFields((d) => new Set(d).add('tokenId'));
  };

  const handlePriorityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.target.value);
    const clamped = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
    setDraftPriority(clamped);
    setDirtyFields((d) => new Set(d).add('priority'));
  };

  const handleWeightChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.target.value);
    const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(1000, Math.trunc(raw))) : 0;
    setDraftWeight(clamped);
    setDirtyFields((d) => new Set(d).add('weight'));
  };

  const handleSave = () => {
    if (dirtyFields.size === 0) return; // No changes — skip

    const updates: { tokenId?: number | null; priority?: number; weight?: number } = {};
    if (dirtyFields.has('tokenId')) {
      // 0 means "follow account default" → send null to backend
      updates.tokenId = draftTokenId > 0 ? draftTokenId : null;
    }
    if (dirtyFields.has('priority')) {
      updates.priority = draftPriority;
    }
    if (dirtyFields.has('weight')) {
      updates.weight = draftWeight;
    }
    onSave(channel.id, updates);
  };

  // --- Token binding presentation ---
  const tokenBinding = describeTokenBinding(
    tokenOptions,
    draftTokenId,
    channel.token?.name ?? null,
    {
      connectionMode: resolveTokenBindingConnectionMode(channel.account),
      accountName: channel.account?.username || `account-${channel.accountId}`,
    },
  );

  const inputDisabled = isUpdatingToken || disabled;
  const hasDirty = dirtyFields.size > 0;

  if (compact) {
    // Mobile: stacked layout
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ width: '100%' }}>
          <ModernSelect
            size="sm"
            value={String(draftTokenId)}
            onChange={handleTokenChange}
            disabled={inputDisabled}
            options={[
              {
                value: '0',
                label: tokenBinding.followOptionLabel,
                description: tokenBinding.followOptionDescription,
              },
              ...tokenOptions.map((token) => ({
                value: String(token.id),
                label: buildFixedTokenOptionLabel(token, { includeDefaultTag: true }),
                description: buildFixedTokenOptionDescription(token),
              })),
            ]}
            placeholder="选择令牌绑定方式"
          />
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
            {tokenBinding.helperText}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <input
              type="number"
              className="input input-sm"
              style={{ width: '100%', maxWidth: 80, padding: '0 4px', textAlign: 'center', height: 32, minHeight: 32, fontSize: 13 }}
              value={draftPriority}
              onChange={handlePriorityChange}
              disabled={inputDisabled}
              min={0}
              step={1}
              title="优先级 (Priority)：数字越小优先级越高，相同优先级的通道之间按权重随机"
              placeholder="0"
            />
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.3, whiteSpace: 'nowrap' }}>优先级</div>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <input
              type="number"
              className="input input-sm"
              style={{ width: '100%', maxWidth: 80, padding: '0 4px', textAlign: 'center', height: 32, minHeight: 32, fontSize: 13 }}
              value={draftWeight}
              onChange={handleWeightChange}
              disabled={inputDisabled}
              min={0}
              max={1000}
              step={1}
              title="权重 (Weight)：同优先级内权重越大被选中概率越高，默认 10"
              placeholder="10"
            />
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.3, whiteSpace: 'nowrap' }}>权重</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <button
            onClick={handleSave}
            disabled={inputDisabled || !hasDirty}
            className="btn btn-link btn-link-info"
            data-tooltip={!hasDirty ? '没有未保存的修改' : undefined}
          >
            {isUpdatingToken ? <span className="spinner spinner-sm" /> : '保存'}
          </button>
          {actions}
        </div>
      </div>
    );
  }

  // Desktop: single-row inline layout
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 180, flex: 1 }}>
        <ModernSelect
          size="sm"
          value={String(draftTokenId)}
          onChange={handleTokenChange}
          disabled={inputDisabled}
          options={[
            {
              value: '0',
              label: tokenBinding.followOptionLabel,
              description: tokenBinding.followOptionDescription,
            },
            ...tokenOptions.map((token) => ({
              value: String(token.id),
              label: buildFixedTokenOptionLabel(token, { includeDefaultTag: true }),
              description: buildFixedTokenOptionDescription(token),
            })),
          ]}
          placeholder="选择令牌绑定方式"
        />
        <div style={{ marginTop: 2, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.3 }}>
          {tokenBinding.helperText}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <input
            type="number"
            className="input input-sm"
            style={{ width: 48, padding: '0 4px', textAlign: 'center', height: 28, minHeight: 28, fontSize: 13 }}
            value={draftPriority}
            onChange={handlePriorityChange}
            disabled={inputDisabled}
            min={0}
            step={1}
            title="优先级 (Priority)：数字越小优先级越高，相同优先级的通道之间按权重随机"
            placeholder="0"
          />
          <div style={{ marginTop: 2, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.3, whiteSpace: 'nowrap' }}>优先级</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <input
            type="number"
            className="input input-sm"
            style={{ width: 48, padding: '0 4px', textAlign: 'center', height: 28, minHeight: 28, fontSize: 13 }}
            value={draftWeight}
            onChange={handleWeightChange}
            disabled={inputDisabled}
            min={0}
            max={1000}
            step={1}
            title="权重 (Weight)：同优先级内权重越大被选中概率越高，默认 10"
            placeholder="10"
          />
          <div style={{ marginTop: 2, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.3, whiteSpace: 'nowrap' }}>权重</div>
        </div>
      </div>
      <button
        onClick={handleSave}
        disabled={inputDisabled || !hasDirty}
        className="btn btn-link btn-link-info"
        data-tooltip={!hasDirty ? '没有未保存的修改' : undefined}
      >
        {isUpdatingToken ? <span className="spinner spinner-sm" /> : '保存'}
      </button>
      {actions}
    </div>
  );
}
