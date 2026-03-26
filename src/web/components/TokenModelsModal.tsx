import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import CenteredModal from './CenteredModal.js';
import { useToast } from './Toast.js';

type FilterMode = 'none' | 'allow-list' | 'deny-list';

type ModelItem = {
  name: string;
  filtered: boolean;
};

type TokenModelsModalProps = {
  open: boolean;
  onClose: () => void;
  tokenId: number;
  tokenName: string;
};

export default function TokenModelsModal({ open, onClose, tokenId, tokenName }: TokenModelsModalProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [filterMode, setFilterMode] = useState<FilterMode>('none');
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(async () => {
    if (!tokenId) return;
    setLoading(true);
    try {
      const [modelsRes, filterRes] = await Promise.all([
        api.getTokenModels(tokenId),
        api.getTokenModelFilter(tokenId),
      ]);
      const modelList: ModelItem[] = Array.isArray(modelsRes?.models)
        ? modelsRes.models.map((m: any) => ({ name: String(m.name || m), filtered: !!m.filtered }))
        : [];
      setModels(modelList);

      const mode = (filterRes?.modelFilterMode || 'none') as FilterMode;
      setFilterMode(mode);

      const filtered: string[] = Array.isArray(filterRes?.filteredModels) ? filterRes.filteredModels : [];
      setSelectedModels(new Set(filtered));
    } catch (e: any) {
      toast.error(e.message || '加载令牌模型失败');
    } finally {
      setLoading(false);
    }
  }, [tokenId, toast]);

  useEffect(() => {
    if (open && tokenId) {
      setSearch('');
      void loadData();
    }
  }, [open, tokenId, loadData]);

  useEffect(() => {
    if (open && !loading && searchRef.current) {
      const timer = setTimeout(() => searchRef.current?.focus(), 120);
      return () => clearTimeout(timer);
    }
  }, [open, loading]);

  const filteredModels = useMemo(() => {
    if (!search.trim()) return models;
    const query = search.trim().toLowerCase();
    return models.filter((m) => m.name.toLowerCase().includes(query));
  }, [models, search]);

  const selectedCount = selectedModels.size;
  const totalCount = models.length;
  const visibleCount = filteredModels.length;

  const toggleModel = (name: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      for (const m of filteredModels) next.add(m.name);
      return next;
    });
  };

  const deselectAllVisible = () => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      for (const m of filteredModels) next.delete(m.name);
      return next;
    });
  };

  const clearAll = () => setSelectedModels(new Set());

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateTokenModelFilter(tokenId, {
        modelFilterMode: filterMode,
        filteredModels: Array.from(selectedModels),
      });
      toast.success('模型过滤配置已保存');
      onClose();
    } catch (e: any) {
      toast.error(e.message || '保存模型过滤失败');
    } finally {
      setSaving(false);
    }
  };

  const modeLabel = (mode: FilterMode) => {
    switch (mode) {
      case 'allow-list': return '白名单（仅允许选中模型）';
      case 'deny-list': return '黑名单（禁用选中模型）';
      default: return '不过滤（全部可用）';
    }
  };

  const modeBadge = filterMode === 'allow-list'
    ? `已选 ${selectedCount} 个模型可用`
    : filterMode === 'deny-list'
      ? `已选 ${selectedCount} 个模型被禁`
      : `全部 ${totalCount} 个模型可用`;

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={`模型管理 · ${tokenName}`}
      maxWidth={720}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '70vh', overflow: 'hidden' }}
      footer={(
        <>
          <button onClick={onClose} className="btn btn-ghost">取消</button>
          <button onClick={handleSave} disabled={saving || loading} className="btn btn-primary">
            {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存配置'}
          </button>
        </>
      )}
    >
      {loading ? (
        <div style={{ padding: 20, textAlign: 'center' }}>
          <span className="spinner" /> 加载中...
        </div>
      ) : (
        <>
          {/* Filter mode selector */}
          <div style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
          }}>
            {(['none', 'allow-list', 'deny-list'] as FilterMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setFilterMode(mode)}
                className={`btn ${filterMode === mode ? 'btn-primary' : 'btn-ghost'}`}
                style={{
                  fontSize: 12,
                  padding: '6px 12px',
                  border: filterMode === mode ? undefined : '1px solid var(--color-border)',
                }}
              >
                {modeLabel(mode)}
              </button>
            ))}
          </div>

          {/* Summary badge */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
          }}>
            <span style={{
              fontSize: 12,
              color: 'var(--color-text-muted)',
              background: 'color-mix(in srgb, var(--color-primary) 8%, var(--color-bg))',
              border: '1px solid color-mix(in srgb, var(--color-primary) 18%, transparent)',
              borderRadius: 'var(--radius-sm)',
              padding: '4px 10px',
            }}>
              {modeBadge} · 总计 {totalCount} 个模型
            </span>
            {filterMode !== 'none' && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" onClick={selectAllVisible} className="btn btn-link btn-link-primary" style={{ fontSize: 12 }}>
                  全选{search.trim() ? '搜索结果' : ''}
                </button>
                <button type="button" onClick={deselectAllVisible} className="btn btn-link" style={{ fontSize: 12 }}>
                  取消{search.trim() ? '搜索结果' : '全选'}
                </button>
                {selectedCount > 0 && (
                  <button type="button" onClick={clearAll} className="btn btn-link btn-link-warning" style={{ fontSize: 12 }}>
                    清空所有
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Search bar */}
          {filterMode !== 'none' && (
            <div style={{ position: 'relative' }}>
              <input
                ref={searchRef}
                type="text"
                placeholder={`搜索模型名称... (共 ${totalCount} 个)`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 14px 10px 36px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                  outline: 'none',
                  background: 'var(--color-bg)',
                  color: 'var(--color-text-primary)',
                }}
              />
              <span style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 14,
                color: 'var(--color-text-muted)',
                pointerEvents: 'none',
              }}>{'\u2315'}</span>
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  style={{
                    position: 'absolute',
                    right: 10,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    fontSize: 16,
                    cursor: 'pointer',
                    color: 'var(--color-text-muted)',
                    padding: 0,
                    lineHeight: 1,
                  }}
                >×</button>
              )}
            </div>
          )}

          {/* Model list */}
          {filterMode !== 'none' && (
            <div style={{
              flex: 1,
              overflowY: 'auto',
              border: '1px solid var(--color-border-light)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg-card)',
              minHeight: 120,
              maxHeight: 'calc(70vh - 240px)',
            }}>
              {visibleCount === 0 ? (
                <div style={{
                  padding: 24,
                  textAlign: 'center',
                  color: 'var(--color-text-muted)',
                  fontSize: 13,
                }}>
                  {search.trim() ? `没有匹配「${search.trim()}」的模型` : '暂无可用模型'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {filteredModels.map((model, i) => {
                    const isChecked = selectedModels.has(model.name);
                    return (
                      <label
                        key={model.name}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 14px',
                          cursor: 'pointer',
                          borderBottom: i < visibleCount - 1 ? '1px solid var(--color-border-light)' : undefined,
                          background: isChecked
                            ? (filterMode === 'allow-list'
                              ? 'color-mix(in srgb, var(--color-success) 6%, var(--color-bg))'
                              : 'color-mix(in srgb, var(--color-danger) 6%, var(--color-bg))')
                            : undefined,
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={(e) => {
                          if (!isChecked) (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, var(--color-primary) 5%, var(--color-bg))';
                        }}
                        onMouseLeave={(e) => {
                          if (!isChecked) (e.currentTarget as HTMLElement).style.background = '';
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleModel(model.name)}
                          style={{ flexShrink: 0 }}
                        />
                        <span style={{
                          fontSize: 13,
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--color-text-primary)',
                          wordBreak: 'break-all',
                          flex: 1,
                        }}>
                          {model.name}
                        </span>
                        {isChecked && (
                          <span
                            className={`badge ${filterMode === 'allow-list' ? 'badge-success' : 'badge-danger'}`}
                            style={{ fontSize: 10, flexShrink: 0 }}
                          >
                            {filterMode === 'allow-list' ? '允许' : '禁用'}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* None mode info */}
          {filterMode === 'none' && (
            <div style={{
              padding: 24,
              textAlign: 'center',
              color: 'var(--color-text-secondary)',
              fontSize: 13,
              border: '1px solid var(--color-border-light)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg-card)',
            }}>
              当前不过滤模型，该令牌的所有 {totalCount} 个模型都可参与路由分发。
              <br />
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                切换到「白名单」或「黑名单」模式来精确控制可用模型。
              </span>
            </div>
          )}
        </>
      )}
    </CenteredModal>
  );
}
