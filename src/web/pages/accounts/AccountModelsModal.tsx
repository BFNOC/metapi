import React from 'react';
import CenteredModal from '../../components/CenteredModal.js';

type AccountModelRow = {
  name: string;
  latencyMs: number | null;
  isManual?: boolean;
};

type AccountModelModalState = {
  open: boolean;
  account: any | null;
  models: AccountModelRow[];
  loading: boolean;
  siteName: string;
  manualModelsInput: string;
  addingManualModels: boolean;
};

type AccountModelsModalProps = {
  modelModal: AccountModelModalState;
  inputStyle: React.CSSProperties;
  onClose: () => void;
  onRefresh: () => Promise<void> | void;
  onManualInputChange: (value: string) => void;
  onAddManualModels: () => Promise<void> | void;
};

export default function AccountModelsModal({
  modelModal,
  inputStyle,
  onClose,
  onRefresh,
  onManualInputChange,
  onAddManualModels,
}: AccountModelsModalProps) {
  return (
    <CenteredModal
      open={modelModal.open}
      onClose={onClose}
      title={modelModal.siteName ? `模型缓存 · ${modelModal.siteName}` : '模型缓存'}
      maxWidth={580}
      footer={(
        <button onClick={onClose} className="btn btn-primary">关闭</button>
      )}
    >
      {modelModal.loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 0', gap: 10 }}>
          <span className="spinner" />
          <span style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>加载模型列表...</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

          {/* Info banner */}
          <div style={{
            padding: '8px 12px',
            background: 'color-mix(in srgb, var(--color-info, #3b82f6) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-info, #3b82f6) 30%, transparent)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 12,
            color: 'var(--color-text-muted)',
          }}>
            此为该站点发现的所有模型缓存（只读），模型过滤（白名单/黑名单）请前往<strong>令牌级</strong>的「模型」管理。
          </div>

          {modelModal.models.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>🤖</div>
              <div style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 8 }}>暂无可用模型</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 16 }}>请先点击「刷新」按钮获取模型列表</div>
              <button
                onClick={() => void onRefresh()}
                className="btn btn-soft-primary"
              >
                立即获取模型
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                  共 <strong style={{ color: 'var(--color-text-primary)' }}>{modelModal.models.length}</strong> 个模型
                </span>
                <button
                  onClick={() => void onRefresh()}
                  disabled={modelModal.loading}
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: '4px 10px' }}
                >
                  刷新模型
                </button>
              </div>

              <div style={{
                maxHeight: 320,
                overflowY: 'auto',
                border: '1px solid var(--color-border-light)',
                borderRadius: 'var(--radius-sm)',
              }}>
                {modelModal.models.map((model, idx) => (
                  <div
                    key={model.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 14px',
                      borderBottom: idx < modelModal.models.length - 1 ? '1px solid var(--color-border-light)' : undefined,
                    }}
                  >
                    <span style={{
                      flex: 1,
                      fontSize: 13,
                      fontFamily: 'var(--font-mono)',
                      wordBreak: 'break-all',
                      color: 'var(--color-text-primary)',
                    }}>
                      {model.name}
                    </span>
                    {model.latencyMs != null ? (
                      <span style={{ fontSize: 11, color: 'var(--color-text-muted)', flexShrink: 0, fontFamily: 'var(--font-mono)' }}>
                        {model.latencyMs}ms
                      </span>
                    ) : null}
                    {model.isManual ? (
                      <span className="badge badge-info" style={{ fontSize: 10, flexShrink: 0, padding: '0 4px' }}>手动</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Manual add section — still useful to manually add models to the cache */}
          <div style={{ marginTop: 12, padding: '12px', background: 'var(--color-bg)', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--color-text-primary)' }}>手动添加模型</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
              如果站点支持但未自动发现的模型，可在此手动添加到缓存（多个以英文逗号分隔）。
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                placeholder="例如: gpt-4-custom, claude-3-5-sonnet-20241022"
                value={modelModal.manualModelsInput}
                onChange={(e) => onManualInputChange(e.target.value)}
                style={{ ...inputStyle, flex: 1, fontFamily: 'var(--font-mono)' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !modelModal.addingManualModels) {
                    void onAddManualModels();
                  }
                }}
              />
              <button
                disabled={!modelModal.manualModelsInput.trim() || modelModal.addingManualModels}
                onClick={() => void onAddManualModels()}
                className="btn btn-primary btn-sm"
                style={{ whiteSpace: 'nowrap' }}
              >
                {modelModal.addingManualModels ? <span className="spinner spinner-sm" /> : '添加'}
              </button>
            </div>
          </div>
        </div>
      )}
    </CenteredModal>
  );
}
