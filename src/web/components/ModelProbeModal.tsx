import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CenteredModal from '../components/CenteredModal.js';
import { api } from '../api.js';

const RANDOM_PROMPTS = [
  '请用一句话解释什么是量子计算',
  'JavaScript 的 Promise 和 async/await 有什么区别？',
  '帮我写一个 Python 的 hello world',
  '什么是 RESTful API？简单说明',
  '计算 237 乘以 18 等于多少',
  '请列举三种常见的排序算法',
  'CSS 中 flex 和 grid 的区别是什么',
  '简单介绍一下 TCP 三次握手',
];

function pickRandomPrompt(): string {
  return RANDOM_PROMPTS[Math.floor(Math.random() * RANDOM_PROMPTS.length)];
}

type ProbeResult = {
  modelName: string;
  status: 'ok' | 'timeout' | 'error';
  ttftMs: number | null;
  httpStatus: number | null;
  error: string | null;
  responseText: string | null;
};

type ModelRow = {
  name: string;
  status: 'pending' | 'probing' | 'ok' | 'timeout' | 'error';
  ttftMs: number | null;
  httpStatus: number | null;
  error: string | null;
  responseText: string | null;
};

type AvailableModel = {
  name: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  siteId: number;
  siteName: string;
  initialModels?: string[];
  tokenId?: number;
  accountId?: number;
};

type SortMode = 'latency' | 'name' | 'status';

export default function ModelProbeModal({ open, onClose, siteId, siteName, initialModels, tokenId, accountId }: Props) {
  const [prompt, setPrompt] = useState(pickRandomPrompt);
  const [concurrency, setConcurrency] = useState(3);
  const [timeoutMs, setTimeoutMs] = useState(15000);
  const [delayMs, setDelayMs] = useState(1500);
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(true);
  const [sortMode, setSortMode] = useState<SortMode>('latency');
  const [loadingModels, setLoadingModels] = useState(false);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);

  // Multi-select model state
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [modelSearch, setModelSearch] = useState('');
  const [manualInput, setManualInput] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // On open: randomize prompt + pre-load models
  useEffect(() => {
    if (!open) return;

    setPrompt(pickRandomPrompt());
    setRows([]);
    setError(null);
    setModelSearch('');
    setManualInput('');

    // If caller provided explicit initialModels, use them
    if (initialModels && initialModels.length > 0) {
      setAvailableModels(initialModels.map((name) => ({ name })));
      setSelectedModels(new Set(initialModels));
      return;
    }

    // Load models for the token (or account)
    setLoadingModels(true);
    if (tokenId) {
      // Load token's discovered models + white-list filter
      Promise.all([
        api.getTokenModels(tokenId),
        (api as any).getTokenModelFilter(tokenId),
      ]).then(([modelsRes, filterRes]: [any, any]) => {
        const modelList: AvailableModel[] = Array.isArray(modelsRes?.models)
          ? modelsRes.models.map((m: any) => ({ name: String(m.name || m) }))
          : [];
        setAvailableModels(modelList);

        // Pre-select allow-list models if configured
        const mode = filterRes?.modelFilterMode || 'none';
        const filtered: string[] = Array.isArray(filterRes?.filteredModels) ? filterRes.filteredModels : [];
        if (mode === 'allow-list' && filtered.length > 0) {
          setSelectedModels(new Set(filtered));
        } else {
          // Default: select all discovered models
          setSelectedModels(new Set(modelList.map((m) => m.name)));
        }
      }).catch(() => {
        setAvailableModels([]);
        setSelectedModels(new Set());
      }).finally(() => setLoadingModels(false));
    } else if (accountId) {
      // API Key connection probe: load account's discovered models
      api.getAccountModels(accountId)
        .then((res: any) => {
          const modelList: AvailableModel[] = Array.isArray(res?.models)
            ? res.models.map((m: any) => ({ name: String(m.name || m) }))
            : [];
          setAvailableModels(modelList);
          setSelectedModels(new Set(modelList.map((m) => m.name)));
        })
        .catch(() => {
          setAvailableModels([]);
          setSelectedModels(new Set());
        })
        .finally(() => setLoadingModels(false));
    } else {
      // Site-level probe without specific account: no pre-loaded model list
      setAvailableModels([]);
      setSelectedModels(new Set());
      setLoadingModels(false);
    }
  }, [open, initialModels, tokenId, accountId, siteId]);

  // Clean up abort on unmount / close
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open]);

  // Compute the final list of model names to probe (selected + manual)
  const resolveProbeModels = useCallback((): string[] => {
    const fromCheckboxes = Array.from(selectedModels);
    const fromManual = manualInput.trim()
      ? manualInput.split(/[,\n]+/).map((m) => m.trim()).filter((m) => m.length > 0)
      : [];
    // Merge, deduplicate
    const merged = new Set([...fromCheckboxes, ...fromManual]);
    return Array.from(merged);
  }, [selectedModels, manualInput]);

  const filteredAvailableModels = useMemo(() => {
    if (!modelSearch.trim()) return availableModels;
    const q = modelSearch.trim().toLowerCase();
    return availableModels.filter((m) => m.name.toLowerCase().includes(q));
  }, [availableModels, modelSearch]);

  const toggleModel = (name: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      for (const m of filteredAvailableModels) next.add(m.name);
      return next;
    });
  };

  const deselectAllVisible = () => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      for (const m of filteredAvailableModels) next.delete(m.name);
      return next;
    });
  };

  const runProbe = useCallback(async () => {
    const models = resolveProbeModels();
    if (models.length === 0) {
      setError('请先在模型列表中勾选要探活的模型，或在下方手动输入模型名称。');
      return;
    }

    // Abort any previous probe
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Initialize all rows as pending
    const initialRows: ModelRow[] = models.map((name) => ({
      name,
      status: 'pending',
      ttftMs: null,
      httpStatus: null,
      error: null,
      responseText: null,
    }));
    setExpandedModel(null);
    setRows(initialRows);
    setProbing(true);
    setError(null);
    setShowSettings(false);

    const probeData = {
      modelNames: models,
      prompt: prompt.trim() || 'hi',
      concurrency: Math.max(1, Math.min(10, concurrency)),
      timeoutMs: Math.max(1000, Math.min(60000, timeoutMs)),
      delayMs: Math.max(0, Math.min(10000, delayMs)),
    };

    // Mark the first batch as probing
    const batchSize = Math.max(1, Math.min(10, concurrency));
    setRows((prev) => prev.map((r, i) => i < batchSize ? { ...r, status: 'probing' } : r));

    // Track which models have been resolved so we can mark next batch as probing
    let resolvedCount = 0;

    const onResult = (result: unknown) => {
      const r = result as ProbeResult;
      resolvedCount++;
      setRows((prev) => {
        const next = prev.map((row) =>
          row.name === r.modelName
            ? { ...row, status: r.status, ttftMs: r.ttftMs, httpStatus: r.httpStatus, error: r.error, responseText: r.responseText }
            : row,
        );
        // Mark the next batch of pending models as probing
        let probing = 0;
        for (const row of next) {
          if (row.status === 'probing') probing++;
        }
        if (probing < batchSize) {
          let toMark = batchSize - probing;
          return next.map((row) => {
            if (toMark > 0 && row.status === 'pending') {
              toMark--;
              return { ...row, status: 'probing' };
            }
            return row;
          });
        }
        return next;
      });
    };

    try {
      const streamFn = tokenId
        ? (api as any).probeAccountTokenModelsStream
        : (api as any).probeModelsStream;
      const id = tokenId || siteId;
      await streamFn(id, probeData, onResult, controller.signal);
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setError(e.message || '探活请求失败');
      }
    } finally {
      setProbing(false);
      // Mark any remaining probing/pending rows as error (in case stream ended early)
      setRows((prev) => prev.map((row) =>
        row.status === 'probing' || row.status === 'pending'
          ? { ...row, status: 'error', error: 'Stream ended unexpectedly' }
          : row,
      ));
    }
  }, [resolveProbeModels, prompt, concurrency, timeoutMs, delayMs, tokenId, siteId]);

  const finishedRows = rows.filter((r) => r.status !== 'pending' && r.status !== 'probing');
  const okRows = finishedRows.filter((r) => r.status === 'ok');
  const failRows = finishedRows.filter((r) => r.status === 'error');
  const timeoutRows = finishedRows.filter((r) => r.status === 'timeout');

  // Stats
  const okLatencies = okRows.map((r) => r.ttftMs || 0).filter((v) => v > 0);
  const avgLatency = okLatencies.length > 0 ? Math.round(okLatencies.reduce((a, b) => a + b, 0) / okLatencies.length) : 0;
  const minLatency = okLatencies.length > 0 ? Math.min(...okLatencies) : 0;
  const maxLatency = okLatencies.length > 0 ? Math.max(...okLatencies) : 0;
  const maxBarLatency = Math.max(maxLatency, timeoutMs, 5000);

  // Sort: only sort finished rows, keep probing/pending at original position
  const sortedRows = [...rows].sort((a, b) => {
    // Pending/probing always at bottom
    const aFinished = a.status !== 'pending' && a.status !== 'probing';
    const bFinished = b.status !== 'pending' && b.status !== 'probing';
    if (!aFinished && !bFinished) return 0;
    if (!aFinished) return 1;
    if (!bFinished) return -1;

    if (sortMode === 'latency') {
      if (a.status === 'ok' && b.status !== 'ok') return -1;
      if (a.status !== 'ok' && b.status === 'ok') return 1;
      return (a.ttftMs || Infinity) - (b.ttftMs || Infinity);
    }
    if (sortMode === 'name') return a.name.localeCompare(b.name);
    const statusOrder = { ok: 0, timeout: 1, error: 2, probing: 3, pending: 4 };
    const diff = statusOrder[a.status] - statusOrder[b.status];
    return diff !== 0 ? diff : (a.ttftMs || 0) - (b.ttftMs || 0);
  });

  const formatMs = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const getLatencyColor = (ms: number) => {
    if (ms < 1500) return '#22c55e';
    if (ms < 3000) return '#84cc16';
    if (ms < 5000) return '#eab308';
    if (ms < 10000) return '#f97316';
    return '#ef4444';
  };

  const getStatusIcon = (status: ModelRow['status']) => {
    if (status === 'ok') return '\u2713';
    if (status === 'timeout') return 'T';
    if (status === 'probing') return '';
    if (status === 'pending') return '';
    return '\u2717';
  };

  const getStatusColor = (status: ModelRow['status']) => {
    if (status === 'ok') return '#22c55e';
    if (status === 'timeout') return '#eab308';
    if (status === 'probing') return 'var(--color-primary)';
    if (status === 'pending') return 'var(--color-text-muted)';
    return '#ef4444';
  };

  const inputStyle = {
    width: '100%',
    padding: '6px 10px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
    outline: 'none',
  } as const;

  const probeModelCount = resolveProbeModels().length;

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={`探活 · ${siteName}`}
      maxWidth={720}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}>

        {/* Action bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={runProbe}
            disabled={probing}
            className="btn btn-primary"
            style={{ minWidth: 100, fontSize: 13 }}
          >
            {probing ? <><span className="spinner spinner-sm" /> 探活中...</> : `开始探活${probeModelCount > 0 ? ` (${probeModelCount})` : ''}`}
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{
              background: 'none',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '5px 10px',
              fontSize: 12,
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
            }}
          >
            {showSettings ? '收起设置' : '展开设置'}
          </button>

          {finishedRows.length > 0 && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, fontSize: 12 }}>
              {(['latency', 'name', 'status'] as SortMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setSortMode(mode)}
                  style={{
                    border: 'none',
                    background: sortMode === mode ? 'var(--color-primary)' : 'var(--color-bg-secondary)',
                    color: sortMode === mode ? '#fff' : 'var(--color-text-muted)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '3px 8px',
                    cursor: 'pointer',
                    fontSize: 11,
                  }}
                >
                  {{ latency: '延迟', name: '名称', status: '状态' }[mode]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Collapsible settings */}
        {showSettings && (
          <div style={{
            background: 'var(--color-bg-secondary)',
            borderRadius: 'var(--radius-md)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}>
            {/* Basic settings grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 3, display: 'block' }}>提示词</label>
                <input style={inputStyle} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="随机" />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 3, display: 'block' }}>并发数</label>
                <input style={inputStyle} type="number" min={1} max={10} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value) || 3)} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 3, display: 'block' }}>超时 (ms)</label>
                <input style={inputStyle} type="number" min={1000} max={60000} step={1000} value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value) || 15000)} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 3, display: 'block' }}>批次间隔 (ms)</label>
                <input style={inputStyle} type="number" min={0} max={10000} step={100} value={delayMs} onChange={(e) => setDelayMs(Number(e.target.value) || 0)} placeholder="0" />
              </div>
            </div>

            {/* Model selection: checkbox list */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <label style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                  {loadingModels
                    ? '正在加载可用模型...'
                    : availableModels.length > 0
                      ? `探活模型（已选 ${selectedModels.size} / ${availableModels.length} 个）`
                      : '探活模型选择'}
                </label>
                {availableModels.length > 0 && !loadingModels && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" onClick={selectAllVisible} className="btn btn-link btn-link-primary" style={{ fontSize: 11, padding: 0 }}>
                      全选{modelSearch.trim() ? '结果' : ''}
                    </button>
                    <button type="button" onClick={deselectAllVisible} className="btn btn-link" style={{ fontSize: 11, padding: 0 }}>
                      取消{modelSearch.trim() ? '结果' : '全选'}
                    </button>
                  </div>
                )}
              </div>

              {loadingModels ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg)', fontSize: 12, color: 'var(--color-text-muted)' }}>
                  <span className="spinner spinner-sm" /> 正在加载模型列表...
                </div>
              ) : availableModels.length > 0 ? (
                <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg)', overflow: 'hidden' }}>
                  {/* Search bar */}
                  <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--color-border-light)', background: 'var(--color-bg-secondary)' }}>
                    <input
                      type="text"
                      placeholder={`搜索模型... (共 ${availableModels.length} 个)`}
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      style={{ ...inputStyle, width: '100%', padding: '4px 8px', fontSize: 11 }}
                    />
                  </div>
                  {/* Checkbox list */}
                  <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                    {filteredAvailableModels.length === 0 ? (
                      <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>
                        没有匹配「{modelSearch}」的模型
                      </div>
                    ) : (
                      filteredAvailableModels.map((model, i) => {
                        const isChecked = selectedModels.has(model.name);
                        return (
                          <label
                            key={model.name}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '6px 12px',
                              cursor: 'pointer',
                              borderBottom: i < filteredAvailableModels.length - 1 ? '1px solid var(--color-border-light)' : undefined,
                              background: isChecked ? 'color-mix(in srgb, var(--color-primary) 8%, var(--color-bg))' : undefined,
                              transition: 'background 0.12s',
                            }}
                            onMouseEnter={(e) => { if (!isChecked) (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-secondary)'; }}
                            onMouseLeave={(e) => { if (!isChecked) (e.currentTarget as HTMLElement).style.background = ''; }}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleModel(model.name)}
                              style={{ flexShrink: 0 }}
                            />
                            <span style={{
                              fontSize: 11,
                              fontFamily: 'monospace',
                              color: 'var(--color-text-primary)',
                              wordBreak: 'break-all',
                              flex: 1,
                            }}>
                              {model.name}
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : (
                <div style={{ padding: '10px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg)', fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>
                  暂无已发现模型，请前往令牌「模型」先刷新模型列表，或在下方手动输入。
                </div>
              )}
            </div>

            {/* Manual input (supplement) */}
            <div>
              <label style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 3, display: 'block' }}>
                手动补充模型（逗号或换行分隔，将与上方勾选合并）
              </label>
              <textarea
                style={{ ...inputStyle, minHeight: 48, resize: 'vertical', fontFamily: 'monospace' }}
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                placeholder="输入模型名称，逗号或换行分隔（可选）"
              />
            </div>
          </div>
        )}

        {/* Summary stats */}
        {finishedRows.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
            gap: 8,
          }}>
            <StatCard label="成功" value={okRows.length} color="#22c55e" />
            <StatCard label="超时" value={timeoutRows.length} color="#eab308" />
            <StatCard label="失败" value={failRows.length} color="#ef4444" />
            {avgLatency > 0 && <StatCard label="平均延迟" value={formatMs(avgLatency)} color="#6366f1" />}
            {minLatency > 0 && <StatCard label="最快" value={formatMs(minLatency)} color="#22c55e" />}
            {maxLatency > 0 && <StatCard label="最慢" value={formatMs(maxLatency)} color="#f97316" />}
          </div>
        )}

        {error && (
          <div style={{
            padding: '8px 12px',
            background: 'var(--color-danger-bg, #fee2e2)',
            color: 'var(--color-danger, #ef4444)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {/* Model list — always visible once probing starts */}
        {rows.length > 0 && (
          <div
            ref={scrollRef}
            style={{
              maxHeight: 420,
              overflow: 'auto',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border)',
            }}
          >
            {sortedRows.map((r) => {
              const isFinished = r.status !== 'pending' && r.status !== 'probing';
              const isExpanded = expandedModel === r.name;
              return (
                <div key={r.name}>
                  <div
                    onClick={isFinished ? () => setExpandedModel(isExpanded ? null : r.name) : undefined}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '22px minmax(120px, 260px) 1fr 60px auto 16px',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 12px',
                      borderBottom: isExpanded ? 'none' : '1px solid var(--color-border)',
                      fontSize: 12,
                      opacity: r.status === 'pending' ? 0.45 : 1,
                      transition: 'opacity 0.3s, background 0.15s',
                      cursor: isFinished ? 'pointer' : 'default',
                      ...(isFinished ? { background: isExpanded ? 'var(--color-bg-secondary)' : undefined } : {}),
                    }}
                    onMouseEnter={(e) => { if (isFinished && !isExpanded) e.currentTarget.style.background = 'var(--color-bg-secondary)'; }}
                    onMouseLeave={(e) => { if (isFinished && !isExpanded) e.currentTarget.style.background = ''; }}
                  >
                    {/* Status icon */}
                    <span style={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 10,
                      fontWeight: 700,
                      flexShrink: 0,
                      color: r.status === 'probing' || r.status === 'pending' ? 'transparent' : '#fff',
                      background: r.status === 'probing' ? 'transparent' : getStatusColor(r.status),
                    }}>
                      {r.status === 'probing' ? (
                        <span className="spinner spinner-sm" style={{ width: 16, height: 16 }} />
                      ) : r.status === 'pending' ? (
                        <span style={{
                          width: 18,
                          height: 18,
                          borderRadius: '50%',
                          border: '2px solid var(--color-border)',
                          display: 'block',
                        }} />
                      ) : (
                        getStatusIcon(r.status)
                      )}
                    </span>

                    {/* Model name */}
                    <span style={{
                      fontFamily: 'monospace',
                      fontSize: 11,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--color-text-primary)',
                    }}>
                      {r.name}
                    </span>

                    {/* Latency bar */}
                    <div style={{
                      height: 16,
                      background: 'var(--color-bg-secondary)',
                      borderRadius: 8,
                      overflow: 'hidden',
                      position: 'relative',
                      minWidth: 60,
                    }}>
                      {r.status === 'probing' && (
                        <div style={{
                          height: '100%',
                          width: '100%',
                          background: 'linear-gradient(90deg, transparent 0%, var(--color-primary) 50%, transparent 100%)',
                          backgroundSize: '200% 100%',
                          animation: 'probe-shimmer 1.5s ease-in-out infinite',
                          borderRadius: 8,
                          opacity: 0.3,
                        }} />
                      )}
                      {r.ttftMs !== null && r.status !== 'probing' && (
                        <div style={{
                          height: '100%',
                          width: `${Math.min(100, Math.max(2, (r.ttftMs / maxBarLatency) * 100))}%`,
                          background: r.status === 'ok'
                            ? `linear-gradient(90deg, ${getLatencyColor(r.ttftMs)}, ${getLatencyColor(r.ttftMs)}cc)`
                            : r.status === 'timeout' ? '#eab30866' : '#ef444466',
                          borderRadius: 8,
                          transition: 'width 0.4s ease',
                        }} />
                      )}
                    </div>

                    {/* Latency value */}
                    <span style={{
                      fontFamily: 'monospace',
                      fontSize: 11,
                      fontWeight: 600,
                      textAlign: 'right',
                      color: r.ttftMs !== null ? getLatencyColor(r.ttftMs) : 'var(--color-text-muted)',
                    }}>
                      {r.status === 'probing' ? '...' : r.status === 'pending' ? '--' : r.ttftMs !== null ? formatMs(r.ttftMs) : '--'}
                    </span>

                    {/* Error detail */}
                    <span
                      title={r.error || undefined}
                      style={{
                        fontSize: 10,
                        color: 'var(--color-text-muted)',
                        maxWidth: 80,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                      }}
                    >
                      {r.error && r.status !== 'ok' && r.status !== 'probing' && r.status !== 'pending'
                        ? (r.httpStatus ? `HTTP ${r.httpStatus}` : r.error)
                        : ''}
                    </span>

                    {/* Expand/collapse chevron */}
                    <span style={{
                      fontSize: 10,
                      color: 'var(--color-text-muted)',
                      transition: 'transform 0.2s',
                      transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      visibility: isFinished ? 'visible' : 'hidden',
                      userSelect: 'none',
                    }}>
                      ▾
                    </span>
                  </div>

                  {/* Expandable detail panel */}
                  {isExpanded && (
                    <div style={{
                      padding: '8px 12px 10px 42px',
                      background: 'var(--color-bg-secondary)',
                      borderBottom: '1px solid var(--color-border)',
                      fontSize: 12,
                      lineHeight: 1.6,
                    }}>
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: (r.responseText || r.error) ? 6 : 0 }}>
                        {r.httpStatus !== null && (
                          <span style={{ color: 'var(--color-text-muted)' }}>
                            HTTP <strong style={{ color: r.httpStatus >= 200 && r.httpStatus < 300 ? '#22c55e' : '#ef4444' }}>{r.httpStatus}</strong>
                          </span>
                        )}
                        {r.ttftMs !== null && (
                          <span style={{ color: 'var(--color-text-muted)' }}>
                            TTFT <strong style={{ color: getLatencyColor(r.ttftMs), fontFamily: 'monospace' }}>{formatMs(r.ttftMs)}</strong>
                          </span>
                        )}
                      </div>
                      {(r.responseText || (r.error && r.status !== 'ok')) ? (
                        <div style={{
                          fontFamily: 'monospace',
                          fontSize: 11,
                          padding: '6px 10px',
                          background: r.status !== 'ok' ? '#ef44440a' : 'var(--color-bg)',
                          border: `1px solid ${r.status !== 'ok' ? '#ef444433' : 'var(--color-border)'}`,
                          borderRadius: 'var(--radius-sm)',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          color: r.status !== 'ok' ? '#ef4444' : 'var(--color-text-primary)',
                          maxHeight: 120,
                          overflow: 'auto',
                        }}>
                          {r.responseText || r.error}
                        </div>
                      ) : (
                        r.status === 'ok' && (
                          <span style={{ color: 'var(--color-text-muted)', fontSize: 11, fontStyle: 'italic' }}>（无回复内容）</span>
                        )
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {!probing && rows.length === 0 && !error && (
          <div style={{
            textAlign: 'center',
            padding: '24px 16px',
            color: 'var(--color-text-muted)',
            fontSize: 13,
          }}>
            {loadingModels
              ? <><span className="spinner spinner-sm" style={{ marginRight: 6 }} />正在加载已启用的模型...</>
              : probeModelCount > 0
                ? `已选 ${probeModelCount} 个模型，点击「开始探活」开始检测`
                : '请在设置中勾选要探活的模型，然后点击「开始探活」'}
          </div>
        )}

        {/* CSS animation for shimmer */}
        <style>{`
          @keyframes probe-shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
        `}</style>
      </div>
    </CenteredModal>
  );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{
      background: `${color}10`,
      border: `1px solid ${color}30`,
      borderRadius: 'var(--radius-md)',
      padding: '8px 10px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color, fontFamily: 'monospace' }}>
        {value}
      </div>
    </div>
  );
}
