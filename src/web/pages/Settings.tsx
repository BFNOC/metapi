import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import ChangeKeyModal from '../components/ChangeKeyModal.js';
import {
  applyRoutingProfilePreset,
  resolveRoutingProfilePreset,
  type RoutingWeights,
} from './helpers/routingProfiles.js';
import { clearAuthSession } from '../authSession.js';
import { tr } from '../i18n.js';

const PROXY_TOKEN_PREFIX = 'sk-';

type RuntimeSettings = {
  checkinCron: string;
  balanceRefreshCron: string;
  routingFallbackUnitCost: number;
  routingWeights: RoutingWeights;
  proxyTokenMasked?: string;
  adminIpAllowlist?: string[];
  currentAdminIp?: string;
};

const defaultWeights: RoutingWeights = {
  baseWeightFactor: 0.5,
  valueScoreFactor: 0.5,
  costWeight: 0.4,
  balanceWeight: 0.3,
  usageWeight: 0.3,
};

export default function Settings() {
  const [runtime, setRuntime] = useState<RuntimeSettings>({
    checkinCron: '0 8 * * *',
    balanceRefreshCron: '0 * * * *',
    routingFallbackUnitCost: 1,
    routingWeights: defaultWeights,
  });
  const [proxyTokenSuffix, setProxyTokenSuffix] = useState('');
  const [maskedToken, setMaskedToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [savingRouting, setSavingRouting] = useState(false);
  const [showAdvancedRouting, setShowAdvancedRouting] = useState(false);
  const [savingSecurity, setSavingSecurity] = useState(false);
  const [adminIpAllowlistText, setAdminIpAllowlistText] = useState('');
  const [clearingCache, setClearingCache] = useState(false);
  const [clearingUsage, setClearingUsage] = useState(false);
  const [showChangeKey, setShowChangeKey] = useState(false);
  const toast = useToast();

  const activeRoutingProfile = useMemo(
    () => resolveRoutingProfilePreset(runtime.routingWeights),
    [runtime.routingWeights],
  );

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 14px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    outline: 'none',
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
  };

  const loadSettings = async () => {
    setLoading(true);
    try {
      const [authInfo, runtimeInfo] = await Promise.all([
        api.getAuthInfo(),
        api.getRuntimeSettings(),
      ]);
      setMaskedToken(authInfo.masked || '****');
      setRuntime({
        checkinCron: runtimeInfo.checkinCron || '0 8 * * *',
        balanceRefreshCron: runtimeInfo.balanceRefreshCron || '0 * * * *',
        routingFallbackUnitCost: Number(runtimeInfo.routingFallbackUnitCost) > 0
          ? Number(runtimeInfo.routingFallbackUnitCost)
          : 1,
        routingWeights: {
          ...defaultWeights,
          ...(runtimeInfo.routingWeights || {}),
        },
        proxyTokenMasked: runtimeInfo.proxyTokenMasked || '',
        adminIpAllowlist: Array.isArray(runtimeInfo.adminIpAllowlist)
          ? runtimeInfo.adminIpAllowlist.filter((item: unknown) => typeof item === 'string')
          : [],
        currentAdminIp: typeof runtimeInfo.currentAdminIp === 'string' ? runtimeInfo.currentAdminIp : '',
      });
      setAdminIpAllowlistText(
        Array.isArray(runtimeInfo.adminIpAllowlist)
          ? runtimeInfo.adminIpAllowlist.join('\n')
          : '',
      );
    } catch (err: any) {
      toast.error(err?.message || '加载设置失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const normalizeProxyTokenSuffix = (raw: string) => {
    const compact = raw.replace(/\s+/g, '');
    if (compact.toLowerCase().startsWith(PROXY_TOKEN_PREFIX)) {
      return compact.slice(PROXY_TOKEN_PREFIX.length);
    }
    return compact;
  };

  const saveSchedule = async () => {
    setSavingSchedule(true);
    try {
      await api.updateRuntimeSettings({
        checkinCron: runtime.checkinCron,
        balanceRefreshCron: runtime.balanceRefreshCron,
      });
      toast.success('定时任务设置已保存');
    } catch (err: any) {
      toast.error(err?.message || '保存失败');
    } finally {
      setSavingSchedule(false);
    }
  };

  const saveProxyToken = async () => {
    const suffix = proxyTokenSuffix.trim();
    if (!suffix) {
      toast.info(tr('请输入 sk- 后的令牌内容'));
      return;
    }
    setSavingToken(true);
    try {
      const res = await api.updateRuntimeSettings({ proxyToken: `${PROXY_TOKEN_PREFIX}${suffix}` });
      setRuntime((prev) => ({ ...prev, proxyTokenMasked: res.proxyTokenMasked || prev.proxyTokenMasked }));
      setProxyTokenSuffix('');
      toast.success(tr('下游访问令牌已更新'));
    } catch (err: any) {
      toast.error(err?.message || '保存失败');
    } finally {
      setSavingToken(false);
    }
  };

  const saveRouting = async () => {
    setSavingRouting(true);
    try {
      await api.updateRuntimeSettings({
        routingWeights: runtime.routingWeights,
        routingFallbackUnitCost: runtime.routingFallbackUnitCost,
      });
      toast.success('路由权重已保存');
    } catch (err: any) {
      toast.error(err?.message || '保存失败');
    } finally {
      setSavingRouting(false);
    }
  };

  const applyRoutingPreset = (preset: 'balanced' | 'stable' | 'cost') => {
    setRuntime((prev) => ({
      ...prev,
      routingWeights: applyRoutingProfilePreset(preset),
    }));
  };

  const saveSecuritySettings = async () => {
    setSavingSecurity(true);
    try {
      const allowlist = adminIpAllowlistText
        .split(/\r?\n|,/g)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const res = await api.updateRuntimeSettings({
        adminIpAllowlist: allowlist,
      });
      setRuntime((prev) => ({
        ...prev,
        adminIpAllowlist: allowlist,
        currentAdminIp: typeof res?.currentAdminIp === 'string'
          ? res.currentAdminIp
          : prev.currentAdminIp,
      }));
      toast.success('安全设置已保存');
    } catch (err: any) {
      toast.error(err?.message || '保存失败');
    } finally {
      setSavingSecurity(false);
    }
  };


  const handleClearCache = async () => {
    if (!window.confirm('确认清理模型缓存并重建路由？')) return;
    setClearingCache(true);
    try {
      const res = await api.clearRuntimeCache();
      toast.success(`缓存已清理（模型缓存 ${res.deletedModelAvailability || 0} 条）`);
    } catch (err: any) {
      toast.error(err?.message || '清理缓存失败');
    } finally {
      setClearingCache(false);
    }
  };

  const handleClearUsage = async () => {
    if (!window.confirm('确认清理占用统计与使用日志？')) return;
    setClearingUsage(true);
    try {
      const res = await api.clearUsageData();
      toast.success(`占用统计已清理（日志 ${res.deletedProxyLogs || 0} 条）`);
    } catch (err: any) {
      toast.error(err?.message || '清理占用失败');
    } finally {
      setClearingUsage(false);
    }
  };

  if (loading) {
    return (
      <div className="animate-fade-in">
        <div className="skeleton" style={{ width: 220, height: 28, marginBottom: 20 }} />
        <div className="skeleton" style={{ width: '100%', height: 320, borderRadius: 'var(--radius-sm)' }} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h2 className="page-title">{tr('系统设置')}</h2>
      </div>

      <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="card animate-slide-up stagger-1" style={{ padding: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>管理员登录令牌</div>
          <code style={{ display: 'block', padding: '10px 14px', background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-light)', marginBottom: 12 }}>
            {maskedToken || '****'}
          </code>
          <button onClick={() => setShowChangeKey(true)} className="btn btn-primary">修改登录令牌</button>
          <ChangeKeyModal
            open={showChangeKey}
            onClose={() => {
              setShowChangeKey(false);
              api.getAuthInfo().then((r: any) => setMaskedToken(r.masked || '****')).catch(() => { });
            }}
          />
        </div>

        <div className="card animate-slide-up stagger-2" style={{ padding: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>定时任务</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>签到 Cron</div>
              <input
                value={runtime.checkinCron}
                onChange={(e) => setRuntime((prev) => ({ ...prev, checkinCron: e.target.value }))}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>余额刷新 Cron</div>
              <input
                value={runtime.balanceRefreshCron}
                onChange={(e) => setRuntime((prev) => ({ ...prev, balanceRefreshCron: e.target.value }))}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
              />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button onClick={saveSchedule} disabled={savingSchedule} className="btn btn-primary">
              {savingSchedule ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存定时任务'}
            </button>
          </div>
        </div>

        <div className="card animate-slide-up stagger-3" style={{ padding: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{tr('下游访问令牌（PROXY_TOKEN）')}</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            {tr('用于下游站点或客户端访问本服务代理接口。前缀 sk- 固定不可修改，只需填写后缀。')}
          </div>
          <code style={{ display: 'block', padding: '10px 14px', background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-light)', marginBottom: 10 }}>
            当前：{runtime.proxyTokenMasked || '未设置'}
          </code>
          <div
            style={{
              ...inputStyle,
              marginBottom: 10,
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                padding: '10px 12px',
                borderRight: '1px solid var(--color-border-light)',
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                color: 'var(--color-text-secondary)',
                userSelect: 'none',
              }}
            >
              {PROXY_TOKEN_PREFIX}
            </span>
            <input
              type="password"
              value={proxyTokenSuffix}
              onChange={(e) => setProxyTokenSuffix(normalizeProxyTokenSuffix(e.target.value))}
              placeholder={tr('请输入 sk- 后的令牌内容')}
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: 'var(--color-text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                padding: '10px 12px',
              }}
            />
          </div>
          <button onClick={saveProxyToken} disabled={savingToken} className="btn btn-primary">
            {savingToken ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : tr('更新下游访问令牌')}
          </button>
        </div>

        <div className="card animate-slide-up stagger-4" style={{ padding: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>路由策略</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            先选择预设策略，只有需要精调时再展开高级参数。
          </div>
          <div style={{ marginBottom: 12, maxWidth: 280 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
              无实测/配置/目录价时默认单价
            </div>
            <input
              type="number"
              min={0.000001}
              step={0.000001}
              value={runtime.routingFallbackUnitCost}
              onChange={(e) => {
                const nextValue = Number(e.target.value);
                setRuntime((prev) => ({
                  ...prev,
                  routingFallbackUnitCost: Number.isFinite(nextValue) && nextValue > 0 ? nextValue : prev.routingFallbackUnitCost,
                }));
              }}
              style={inputStyle}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button
              onClick={() => applyRoutingPreset('balanced')}
              className="btn btn-ghost"
              style={{
                border: activeRoutingProfile === 'balanced' ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                color: activeRoutingProfile === 'balanced' ? 'var(--color-primary)' : undefined,
              }}
            >
              均衡
            </button>
            <button
              onClick={() => applyRoutingPreset('stable')}
              className="btn btn-ghost"
              style={{
                border: activeRoutingProfile === 'stable' ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                color: activeRoutingProfile === 'stable' ? 'var(--color-primary)' : undefined,
              }}
            >
              稳定优先
            </button>
            <button
              onClick={() => applyRoutingPreset('cost')}
              className="btn btn-ghost"
              style={{
                border: activeRoutingProfile === 'cost' ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                color: activeRoutingProfile === 'cost' ? 'var(--color-primary)' : undefined,
              }}
            >
              成本优先
            </button>
            <button
              onClick={() => setShowAdvancedRouting((prev) => !prev)}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
            >
              {showAdvancedRouting ? '收起高级参数' : '展开高级参数'}
            </button>
          </div>

          {showAdvancedRouting && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {([
                ['baseWeightFactor', '基础权重因子'],
                ['valueScoreFactor', '价值分因子'],
                ['costWeight', '成本权重'],
                ['balanceWeight', '余额权重'],
                ['usageWeight', '使用频次权重'],
              ] as Array<[keyof RoutingWeights, string]>).map(([key, label]) => (
                <div key={key}>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{label}</div>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={runtime.routingWeights[key]}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setRuntime((prev) => ({
                        ...prev,
                        routingWeights: {
                          ...prev.routingWeights,
                          [key]: Number.isFinite(v) ? v : 0,
                        },
                      }));
                    }}
                    style={inputStyle}
                  />
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <button onClick={saveRouting} disabled={savingRouting} className="btn btn-primary">
              {savingRouting ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存路由策略'}
            </button>
          </div>
        </div>

        <div className="card animate-slide-up stagger-6" style={{ padding: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>维护工具</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={handleClearCache} disabled={clearingCache} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>
              {clearingCache ? <><span className="spinner spinner-sm" /> 清理中...</> : '清除缓存并重建路由'}
            </button>
            <button onClick={handleClearUsage} disabled={clearingUsage} className="btn btn-link btn-link-warning">
              {clearingUsage ? <><span className="spinner spinner-sm" /> 清理中...</> : '清除占用与使用日志'}
            </button>
          </div>
        </div>

        <div className="card animate-slide-up stagger-7" style={{ padding: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>会话与安全</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            登录会话默认 12 小时自动过期。可选配置管理端 IP 白名单（每行一个 IP）。
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
            {tr('当前识别到的管理端 IP（由服务端判定）：')}
          </div>
          <code style={{ display: 'block', padding: '10px 14px', background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-light)', marginBottom: 10 }}>
            {runtime.currentAdminIp || tr('未知')}
          </code>
          <textarea
            value={adminIpAllowlistText}
            onChange={(e) => setAdminIpAllowlistText(e.target.value)}
            placeholder={'例如：\n127.0.0.1\n192.168.1.10'}
            rows={4}
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)', resize: 'vertical', marginBottom: 10 }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={saveSecuritySettings} disabled={savingSecurity} className="btn btn-primary">
              {savingSecurity ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存安全设置'}
            </button>
            <button
              onClick={() => {
                clearAuthSession(localStorage);
                window.location.reload();
              }}
              className="btn btn-danger"
            >
              退出登录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
