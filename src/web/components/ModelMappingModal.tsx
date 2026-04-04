import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import CenteredModal from './CenteredModal.js';

type MappingEntry = {
  requestModel: string;
  upstreamModel: string;
};

type ModelMappingModalProps = {
  open: boolean;
  onClose: () => void;
  targetName?: string;
  accountName?: string;
  initialMapping: Record<string, string> | null;
  availableModels: string[];
  loadingModels: boolean;
  onSave: (mapping: Record<string, string> | null) => Promise<void>;
};

function parseMapping(raw: Record<string, string> | null | undefined): MappingEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .filter(([k, v]) => k.trim() && v.trim())
    .map(([requestModel, upstreamModel]) => ({ requestModel: requestModel.trim(), upstreamModel: upstreamModel.trim() }));
}

function entriesToMapping(entries: MappingEntry[]): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.requestModel.trim();
    const value = entry.upstreamModel.trim();
    if (key && value) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** Full-screen model picker overlay — large, searchable, comfortable to use with 100+ models */
function ModelPickerOverlay({
  models,
  currentValue,
  onSelect,
  onClose,
}: {
  models: string[];
  currentValue: string;
  onSelect: (model: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, [onClose]);

  const filtered = useMemo(() => {
    if (!search.trim()) return models;
    const lower = search.toLowerCase();
    return models.filter((m) => m.toLowerCase().includes(lower));
  }, [models, search]);

  const overlay = (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--color-bg)',
          borderRadius: 'var(--radius-md, 12px)',
          width: '90vw',
          maxWidth: 560,
          height: '70vh',
          maxHeight: 600,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px 12px',
          borderBottom: '1px solid var(--color-border)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              选择上游模型
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                fontSize: 18,
                cursor: 'pointer',
                color: 'var(--color-text-muted)',
                padding: '2px 6px',
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索模型名…"
            style={{
              width: '100%',
              padding: '10px 14px',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 14,
              background: 'var(--color-surface, var(--color-bg))',
              color: 'var(--color-text-primary)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-muted)' }}>
            共 {models.length} 个模型{search.trim() ? `，匹配 ${filtered.length} 个` : ''}
          </div>
        </div>

        {/* Model list */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 0',
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
              {search.trim() ? '无匹配模型' : '暂无已发现模型'}
            </div>
          ) : (
            filtered.map((model) => {
              const isSelected = model === currentValue;
              return (
                <div
                  key={model}
                  onClick={() => { onSelect(model); onClose(); }}
                  style={{
                    padding: '10px 20px',
                    fontSize: 13,
                    fontFamily: 'var(--font-mono, monospace)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    background: isSelected ? 'var(--color-primary-surface, rgba(99,102,241,0.1))' : 'transparent',
                    color: isSelected ? 'var(--color-primary)' : 'var(--color-text-primary)',
                    fontWeight: isSelected ? 600 : 400,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'var(--color-surface, rgba(0,0,0,0.03))';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = isSelected ? 'var(--color-primary-surface, rgba(99,102,241,0.1))' : 'transparent';
                  }}
                >
                  <span style={{
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    border: isSelected ? 'none' : '2px solid var(--color-border)',
                    background: isSelected ? 'var(--color-primary)' : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    color: '#fff',
                    flexShrink: 0,
                  }}>
                    {isSelected ? '✓' : ''}
                  </span>
                  <span style={{ wordBreak: 'break-all' }}>{model}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

export default function ModelMappingModal({
  open,
  onClose,
  targetName,
  accountName,
  initialMapping,
  availableModels,
  loadingModels,
  onSave,
}: ModelMappingModalProps) {
  const displayName = targetName || accountName || '';
  const [entries, setEntries] = useState<MappingEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);

  useEffect(() => {
    if (open) {
      const parsed = parseMapping(initialMapping);
      setEntries(parsed.length > 0 ? parsed : [{ requestModel: '', upstreamModel: '' }]);
      setPickerIndex(null);
    }
  }, [open, initialMapping]);

  const updateEntry = (index: number, field: keyof MappingEntry, value: string) => {
    setEntries((prev) => prev.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)));
  };

  const addEntry = () => {
    setEntries((prev) => [...prev, { requestModel: '', upstreamModel: '' }]);
  };

  const removeEntry = (index: number) => {
    setEntries((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : [{ requestModel: '', upstreamModel: '' }];
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(entriesToMapping(entries));
      onClose();
    } catch {
      // error handled by caller's toast
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      await onSave(null);
      onClose();
    } catch {
      // error handled by caller
    } finally {
      setSaving(false);
    }
  };

  const hasValidEntries = entries.some((e) => e.requestModel.trim() && e.upstreamModel.trim());

  const inputStyle: React.CSSProperties = {
    flex: 1,
    padding: '8px 12px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
    outline: 'none',
    minWidth: 0,
    fontFamily: 'var(--font-mono, monospace)',
  };

  const selectTriggerStyle: React.CSSProperties = {
    ...inputStyle,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    userSelect: 'none',
  };

  return (
    <>
      <CenteredModal
        open={open}
        onClose={onClose}
        title={`模型映射 — ${displayName}`}
        maxWidth={700}
        closeOnBackdrop
        closeOnEscape
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', width: '100%' }}>
            <div>
              {initialMapping && Object.keys(initialMapping).length > 0 && (
                <button
                  type="button"
                  className="btn btn-link btn-link-danger"
                  onClick={handleClear}
                  disabled={saving}
                >
                  清除全部
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving || !hasValidEntries}>
                {saving ? <span className="spinner spinner-sm" /> : '保存'}
              </button>
            </div>
          </div>
        )}
      >
        <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
          将请求中的模型名映射为当前目标的上游实际模型名。点击右侧按钮从已发现模型中选择。
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Header row */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingRight: 32 }}>
            <div style={{ flex: 1, fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 600 }}>请求模型名（你想用的名字）</div>
            <div style={{ width: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--color-text-muted)' }} />
            <div style={{ flex: 1, fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 600 }}>
              上游实际模型名
              {loadingModels && <span className="spinner spinner-sm" style={{ marginLeft: 6 }} />}
            </div>
          </div>

          {entries.map((entry, index) => (
            <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={entry.requestModel}
                onChange={(e) => updateEntry(index, 'requestModel', e.target.value)}
                placeholder="glm-5"
                style={inputStyle}
              />
              <div style={{ fontSize: 14, color: 'var(--color-text-muted)', flexShrink: 0 }}>→</div>
              {availableModels.length > 0 ? (
                <div
                  onClick={() => setPickerIndex(index)}
                  style={selectTriggerStyle}
                  title={entry.upstreamModel || '点击选择上游模型'}
                >
                  <span style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: entry.upstreamModel ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                  }}>
                    {entry.upstreamModel || '点击选择…'}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--color-text-muted)', flexShrink: 0 }}>▼</span>
                </div>
              ) : (
                <input
                  type="text"
                  value={entry.upstreamModel}
                  onChange={(e) => updateEntry(index, 'upstreamModel', e.target.value)}
                  placeholder={loadingModels ? '加载中…' : '输入上游模型名'}
                  style={inputStyle}
                  disabled={loadingModels}
                />
              )}
              <button
                type="button"
                onClick={() => removeEntry(index)}
                className="btn btn-link btn-link-danger"
                style={{ padding: '4px 6px', fontSize: 14, lineHeight: 1, flexShrink: 0 }}
                title="删除此条"
              >
                ×
              </button>
            </div>
          ))}

          <button
            type="button"
            className="btn btn-link btn-link-primary"
            onClick={addEntry}
            style={{ alignSelf: 'flex-start', fontSize: 12, padding: '4px 0' }}
          >
            + 添加映射规则
          </button>
        </div>
      </CenteredModal>

      {/* Full-screen model picker overlay */}
      {pickerIndex !== null && availableModels.length > 0 && (
        <ModelPickerOverlay
          models={availableModels}
          currentValue={entries[pickerIndex]?.upstreamModel || ''}
          onSelect={(model) => updateEntry(pickerIndex, 'upstreamModel', model)}
          onClose={() => setPickerIndex(null)}
        />
      )}
    </>
  );
}
