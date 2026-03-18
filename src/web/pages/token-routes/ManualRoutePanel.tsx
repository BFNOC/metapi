import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import ModernSelect from '../../components/ModernSelect.js';
import { tr } from '../../i18n.js';
import type { RouteIconOption, RouteMode, RouteSummaryRow } from './types.js';
import {
  getModelPatternError,
  isExactModelPattern,
  matchesModelPattern,
  normalizeRouteDisplayIconValue,
  normalizeRouteMode,
} from './utils.js';

type RouteEditorForm = {
  routeMode: RouteMode;
  displayName: string;
  displayIcon: string;
  modelPattern: string;
  sourceRouteIds: number[];
  advancedOpen: boolean;
};

type ManualRoutePanelProps = {
  show: boolean;
  editingRouteId: number | null;
  form: RouteEditorForm;
  setForm: Dispatch<SetStateAction<RouteEditorForm>>;
  saving: boolean;
  canSave: boolean;
  routeIconSelectOptions: RouteIconOption[];
  previewModelSamples: string[];
  exactSourceRouteOptions: RouteSummaryRow[];
  onSave: () => void;
  onCancel: () => void;
};

function renderRouteOptionLabel(route: RouteSummaryRow): string {
  const displayName = (route.displayName || '').trim();
  return displayName || route.modelPattern;
}

function toggleSourceRouteId(sourceRouteIds: number[], routeId: number): number[] {
  if (sourceRouteIds.includes(routeId)) {
    return sourceRouteIds.filter((id) => id !== routeId);
  }
  return [...sourceRouteIds, routeId].sort((a, b) => a - b);
}

export default function ManualRoutePanel({
  show,
  editingRouteId,
  form,
  setForm,
  saving,
  canSave,
  routeIconSelectOptions,
  previewModelSamples,
  exactSourceRouteOptions,
  onSave,
  onCancel,
}: ManualRoutePanelProps) {
  const [sourceSearch, setSourceSearch] = useState('');

  useEffect(() => {
    if (!show) {
      setSourceSearch('');
    }
  }, [show]);

  const routeMode = normalizeRouteMode(form.routeMode);
  const editingLegacyPatternGroup = editingRouteId !== null && routeMode === 'pattern';

  const modelPatternError = useMemo(
    () => getModelPatternError(form.modelPattern),
    [form.modelPattern],
  );

  const routeIconOptionValues = useMemo(
    () => new Set(routeIconSelectOptions.map((option) => option.value)),
    [routeIconSelectOptions],
  );

  const routeIconSelectValue = routeIconOptionValues.has(normalizeRouteDisplayIconValue(form.displayIcon))
    ? normalizeRouteDisplayIconValue(form.displayIcon)
    : '';

  const previewMatchedModels = useMemo(() => {
    const normalizedPattern = form.modelPattern.trim();
    if (!normalizedPattern || modelPatternError) return [] as string[];
    return previewModelSamples.filter((modelName) => matchesModelPattern(modelName, normalizedPattern));
  }, [form.modelPattern, modelPatternError, previewModelSamples]);

  const filteredSourceRoutes = useMemo(() => {
    const normalizedSearch = sourceSearch.trim().toLowerCase();
    if (!normalizedSearch) return exactSourceRouteOptions;
    return exactSourceRouteOptions.filter((route) => {
      const label = renderRouteOptionLabel(route).toLowerCase();
      return label.includes(normalizedSearch) || route.modelPattern.toLowerCase().includes(normalizedSearch);
    });
  }, [exactSourceRouteOptions, sourceSearch]);

  const selectedSourceRoutes = useMemo(() => {
    const routeById = new Map(exactSourceRouteOptions.map((route) => [route.id, route]));
    return form.sourceRouteIds
      .map((routeId) => routeById.get(routeId))
      .filter((route): route is RouteSummaryRow => !!route);
  }, [exactSourceRouteOptions, form.sourceRouteIds]);

  const footer = (
    <>
      <button
        type="button"
        onClick={onCancel}
        className="btn btn-ghost"
        style={{ border: '1px solid var(--color-border)' }}
      >
        {editingRouteId ? tr('取消编辑') : tr('取消')}
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={!canSave}
        className="btn btn-success"
      >
        {saving ? (
          <>
            <span
              className="spinner spinner-sm"
              style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }}
            />{' '}
            {tr('保存中...')}
          </>
        ) : (
          tr(editingRouteId ? '保存群组' : '创建群组')
        )}
      </button>
    </>
  );

  return (
    <CenteredModal
      open={show}
      onClose={onCancel}
      title={editingRouteId ? tr('编辑群组') : tr('新建群组')}
      footer={footer}
      maxWidth={860}
      closeOnEscape
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {editingLegacyPatternGroup ? (
          <div
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: '12px 14px',
              background: 'var(--color-bg-card)',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>
              {tr('高级规则群组')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              {tr('该群组使用高级模型匹配规则创建，普通模式不可编辑；修改后会按当前可用模型重新匹配自动通道。')}
            </div>
          </div>
        ) : routeMode === 'explicit_group' ? (
          <div
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: '12px 14px',
              background: 'var(--color-bg-card)',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>
              {tr('模型重定向')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              {tr('将多个现有模型合并为一个对外模型名，实现模型重定向。')}
            </div>
          </div>
        ) : (
          <div
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: '12px 14px',
              background: 'var(--color-bg-card)',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>
              {tr('高级规则群组')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              {tr('使用模型匹配规则创建群组，适合需要 regex / glob 的高级场景。')}
            </div>
          </div>
        )}

        {routeMode === 'explicit_group' ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{tr('对外模型名')}</span>
                <input
                  placeholder={tr('对外模型名（例如 claude-opus-4-6）')}
                  value={form.displayName}
                  onChange={(e) => setForm((current) => ({ ...current, displayName: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 13,
                    outline: 'none',
                    background: 'var(--color-bg)',
                    color: 'var(--color-text-primary)',
                  }}
                />
              </label>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                    {tr('来源模型')}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    {tr('选择一个或多个现有精确模型路由作为来源。')}
                  </div>
                </div>
                {!editingRouteId && (
                  <button
                    type="button"
                    className="btn btn-link"
                    onClick={() => setForm((current) => ({ ...current, routeMode: 'pattern', advancedOpen: true }))}
                  >
                    {tr('改用高级规则')}
                  </button>
                )}
              </div>

              <input
                placeholder={tr('搜索来源模型')}
                value={sourceSearch}
                onChange={(e) => setSourceSearch(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                  outline: 'none',
                  background: 'var(--color-bg)',
                  color: 'var(--color-text-primary)',
                }}
              />

              {selectedSourceRoutes.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {selectedSourceRoutes.map((route) => (
                    <button
                      key={`selected-${route.id}`}
                      type="button"
                      className="badge badge-info"
                      style={{ fontSize: 11, cursor: 'pointer' }}
                      onClick={() => setForm((current) => ({
                        ...current,
                        sourceRouteIds: toggleSourceRouteId(current.sourceRouteIds, route.id),
                      }))}
                    >
                      {renderRouteOptionLabel(route)} ×
                    </button>
                  ))}
                </div>
              )}

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: 10,
                  maxHeight: 280,
                  overflowY: 'auto',
                  paddingRight: 4,
                }}
              >
                {filteredSourceRoutes.map((route) => {
                  const selected = form.sourceRouteIds.includes(route.id);
                  const label = renderRouteOptionLabel(route);
                  return (
                    <button
                      key={route.id}
                      type="button"
                      onClick={() => setForm((current) => ({
                        ...current,
                        sourceRouteIds: toggleSourceRouteId(current.sourceRouteIds, route.id),
                      }))}
                      className="btn btn-ghost"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        gap: 6,
                        padding: '12px 14px',
                        border: `1px solid ${selected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                        background: selected ? 'color-mix(in srgb, var(--color-primary) 8%, var(--color-bg-card))' : 'var(--color-bg-card)',
                        boxShadow: selected ? '0 0 0 1px color-mix(in srgb, var(--color-primary) 25%, transparent)' : 'none',
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{label}</span>
                      {label !== route.modelPattern && (
                        <code style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{route.modelPattern}</code>
                      )}
                      <span style={{ fontSize: 11, color: selected ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>
                        {selected ? tr('已选中') : tr('点击添加')}
                      </span>
                    </button>
                  );
                })}
              </div>

              {filteredSourceRoutes.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  {tr('没有匹配的来源模型。')}
                </div>
              )}
            </div>

            <details
              open={form.advancedOpen}
              onToggle={(event) => {
                const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
                setForm((current) => ({ ...current, advancedOpen: nextOpen }));
              }}
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                padding: '0 14px',
                background: 'var(--color-bg-card)',
              }}
            >
              <summary style={{ cursor: 'pointer', padding: '12px 0', fontSize: 13, fontWeight: 600 }}>
                {tr('高级配置')}
              </summary>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, paddingBottom: 14 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{tr('群组图标')}</span>
                  <ModernSelect
                    value={routeIconSelectValue}
                    onChange={(nextValue) => setForm((current) => ({ ...current, displayIcon: nextValue }))}
                    options={routeIconSelectOptions}
                    placeholder={tr('图标（可选，选择品牌图标）')}
                    emptyLabel={tr('暂无可选品牌图标')}
                  />
                </label>
              </div>
            </details>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {!editingLegacyPatternGroup && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => setForm((current) => ({
                    ...current,
                    routeMode: 'explicit_group',
                    advancedOpen: false,
                  }))}
                >
                  {tr('返回简单模式')}
                </button>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', gap: 12 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{tr('群组显示名')}</span>
                <input
                  placeholder={tr('群组显示名（可选，例如 claude-opus-4-6）')}
                  value={form.displayName}
                  onChange={(e) => setForm((current) => ({ ...current, displayName: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 13,
                    outline: 'none',
                    background: 'var(--color-bg)',
                    color: 'var(--color-text-primary)',
                  }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{tr('群组图标')}</span>
                <ModernSelect
                  value={routeIconSelectValue}
                  onChange={(nextValue) => setForm((current) => ({ ...current, displayIcon: nextValue }))}
                  options={routeIconSelectOptions}
                  placeholder={tr('图标（可选，选择品牌图标）')}
                  emptyLabel={tr('暂无可选品牌图标')}
                />
              </label>
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{tr('模型匹配')}</span>
              <input
                placeholder={tr('模型匹配（如 gpt-4o、claude-*、re:^claude-.*$）')}
                value={form.modelPattern}
                onChange={(e) => setForm((current) => ({ ...current, modelPattern: e.target.value }))}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  border: `1px solid ${modelPatternError ? 'var(--color-danger)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                  outline: 'none',
                  background: 'var(--color-bg)',
                  color: 'var(--color-text-primary)',
                  fontFamily: 'var(--font-mono)',
                }}
              />
            </label>

            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: -4 }}>
              {isExactModelPattern(form.modelPattern)
                ? tr('当前为精确模型匹配。')
                : tr('正则请使用 re: 前缀；例如 re:^claude-(opus|sonnet)-4-6$')}
            </div>

            {modelPatternError && (
              <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: -4 }}>
                {modelPatternError}
              </div>
            )}

            {form.modelPattern.trim() && !modelPatternError && (
              <div
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '10px 12px',
                  background: 'var(--color-bg)',
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                  {tr('规则预览：命中样本')} {previewMatchedModels.length} / {previewModelSamples.length}
                </div>

                {previewModelSamples.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    {tr('当前暂无可预览模型，请先同步模型。')}
                  </div>
                ) : previewMatchedModels.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    {tr('当前规则未命中任何样本模型。')}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {previewMatchedModels.slice(0, 12).map((modelName) => (
                      <code
                        key={modelName}
                        style={{
                          fontSize: 11,
                          padding: '2px 6px',
                          borderRadius: 6,
                          border: '1px solid var(--color-border)',
                          background: 'var(--color-bg-card)',
                        }}
                      >
                        {modelName}
                      </code>
                    ))}
                  </div>
                )}

                {previewMatchedModels.length > 12 && (
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>
                    {tr('仅展示前 12 个命中样本。')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </CenteredModal>
  );
}
