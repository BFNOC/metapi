# 探活状态分类优化 - 最终实施方案（Codex 二次评审后）

**日期**: 2026-04-04
**状态**: ✅ 已通过 Codex 二次评审，准备实施

## 评审历程

1. **原方案**：将 `inconclusive` 改为 `unsupported` - ❌ Codex 否决（破坏持久化语义）
2. **修正方案**：使用派生分类 - ⚠️ Codex 指出重要遗漏
3. **最终方案**：修正派生规则，扩大影响范围 - ✅ Codex 认可

## Codex 第二次评审核心发现

### 🚨 高风险问题

1. **行为回归风险**
   - 原派生函数：`status === 'skipped'` → 直接返回 `skipped`
   - 现有行为：`401/403/429` 会被沉底处理
   - **问题**：会让认证/限流失败从"沉底"退回成"跳过"

2. **UI 分叉风险**
   - 遗漏了 `SortableChannelRow.tsx:88` 的 badge 展示
   - 只改统计不改 badge 会导致："卡片显示失败 +1，但每行还是 ❓"

### ⚠️ 中风险问题

3. **路由影响被高估**
   - `apply-probe-ranking` 只改 `priority/weight`
   - `round_robin` 策略会忽略 priority
   - 实际影响取决于路由策略

4. **第五态成本被低估**
   - 需要改 shared contract、API、SSE、快照、测试
   - 成本远高于派生分类

## 最终方案

### 核心原则

> `raw status` 不动，补一个 `src/shared/` 的共享派生 helper，只服务 route ranking 和 route UI；`ModelProbeModal` 继续显示 raw 四态。

### 派生函数（修正版）

```typescript
// src/shared/probeHealthClassifier.ts

export type ProbeHealthStatus = 'success' | 'failure' | 'unknown' | 'skipped';

/**
 * 将探活 raw status 派生为健康状态，用于 UI 展示和排序
 *
 * 注意：此函数不影响持久化逻辑，仅用于展示层
 */
export function deriveProbeHealthStatus(
  status: 'supported' | 'unsupported' | 'inconclusive' | 'skipped',
  httpStatus: number | null,
  error: string | null
): ProbeHealthStatus {
  // 成功
  if (status === 'supported') return 'success';

  // 认证/限流问题 - 归为失败并沉底（保持现有行为）
  if (status === 'skipped') {
    // 有 HTTP 状态码的 skipped 视为失败（401/403/429）
    if (httpStatus != null) return 'failure';
    // 无 HTTP 状态码的 skipped（如"通道无有效探活令牌"）视为跳过
    return 'skipped';
  }

  // 模型不支持
  if (status === 'unsupported') return 'failure';

  // 明确的运行时故障（5xx、超时、网络错误等）
  const errorLower = error?.toLowerCase() || '';

  // 5xx 错误
  if (httpStatus && httpStatus >= 500) return 'failure';

  // 超时
  if (errorLower.includes('timeout after')) return 'failure';

  // 网络错误
  if (errorLower.includes('fetch failed')) return 'failure';

  // 网关错误
  if (errorLower.includes('bad gateway')) return 'failure';

  // 服务不可用
  if (errorLower.includes('service temporarily')) return 'failure';

  // 资源过载
  if (errorLower.includes('overload')) return 'failure';

  // 配置错误
  if (errorLower.includes('无可用渠道')) return 'failure';
  if (errorLower.includes('unknown provider')) return 'failure';

  // HTML 错误页（Cloudflare 等）
  if (errorLower.includes('<!doctype html>')) return 'failure';
  if (errorLower.includes('<html')) return 'failure';

  // 真正无法判断的情况
  // - "No response body"
  // - "Stream ended immediately"
  // - "Probe returned no result"
  return 'unknown';
}

/**
 * 统计探活结果的健康状态分布
 */
export function aggregateProbeHealthStats(
  results: Array<{ status: string; httpStatus: number | null; error: string | null }>
): {
  successCount: number;
  failureCount: number;
  unknownCount: number;
  skippedCount: number;
} {
  let successCount = 0;
  let failureCount = 0;
  let unknownCount = 0;
  let skippedCount = 0;

  for (const result of results) {
    const health = deriveProbeHealthStatus(
      result.status as any,
      result.httpStatus,
      result.error
    );

    if (health === 'success') successCount++;
    else if (health === 'failure') failureCount++;
    else if (health === 'unknown') unknownCount++;
    else if (health === 'skipped') skippedCount++;
  }

  return { successCount, failureCount, unknownCount, skippedCount };
}
```

### 实施范围（修正版）

#### Phase 1: 核心实现（必须）

1. ✅ 创建 `src/shared/probeHealthClassifier.ts`
2. ✅ 添加单元测试 `src/shared/probeHealthClassifier.test.ts`
3. ✅ 修改 `src/server/routes/api/tokens.ts:602` 排序逻辑
4. ✅ 修改 `src/web/pages/token-routes/RouteCard.tsx:219` 统计逻辑
5. ✅ 修改 `src/web/pages/token-routes/SortableChannelRow.tsx:88` badge 展示
6. ✅ 更新相关测试

#### Phase 2: 完善展示（可选）

1. ⬜ 决定是否修改 `ModelProbeModal.tsx` 展示
2. ⬜ 添加 UI 说明文案
3. ⬜ 考虑同时显示 raw status 和 derived health

#### Phase 3: 监控和调整（可选）

1. ⬜ 监控沉底渠道数量
2. ⬜ 收集用户反馈
3. ⬜ 根据反馈调整派生规则

## 关键修正点

### 1. 401/403/429 处理

**原方案**（错误）:
```typescript
if (status === 'skipped') return 'skipped';  // ❌ 会让 401/403/429 从沉底掉出去
```

**修正方案**（正确）:
```typescript
if (status === 'skipped') {
  if (httpStatus != null) return 'failure';  // ✅ 保持沉底行为
  return 'skipped';
}
```

### 2. SortableChannelRow badge

**必须修改**，否则会出现 UI 分叉：
```typescript
// src/web/pages/token-routes/SortableChannelRow.tsx:88
const health = deriveProbeHealthStatus(probeResult.status, probeResult.httpStatus, probeResult.error);
// 根据 health 显示 badge，而不是直接用 raw status
```

### 3. 统计桶数

**RouteCard 需要支持四桶**（不是三桶）:
```typescript
const { successCount, failureCount, unknownCount, skippedCount } = aggregateProbeHealthStats(results);
// 展示：成功 / 失败 / 未知 / 跳过（或合并跳过到未知）
```

## 影响评估（修正版）

| 影响类型 | 影响范围 | 风险等级 | 说明 |
|---------|---------|---------|------|
| 持久化 | 无影响 | 无 | raw status 不变 |
| 后台任务 | 无影响 | 无 | 继续使用 raw status |
| 前端统计 | 需修改 | 低 | 使用派生结果 |
| 排序逻辑 | 需修改 | 低 | 使用派生结果 |
| 通道 badge | **需修改** | 中 | **新增**，避免 UI 分叉 |
| 探活弹窗 | 不修改 | 无 | 保持 raw 四态 |
| 路由策略 | 部分影响 | 低 | 取决于策略类型 |

## 预期效果（修正版）

### UI 展示层
- ✅ 成功：5
- ❌ 失败：28（包含 7 原失败 + 21 运行时故障）
- ❓ 未知：0（只保留真正无法判断的）
- ⏭️ 跳过：0（无令牌等情况）

### 持久化层
- `supported` → `available=true`
- `unsupported` → `available=false`
- `inconclusive/skipped` → 不修改 available

### 路由层
- `weighted/stable_first` 策略：故障渠道沉底
- `round_robin` 策略：影响较小（忽略 priority）

## 测试覆盖

### 单元测试

```typescript
describe('deriveProbeHealthStatus', () => {
  it('401/403/429 with httpStatus should be failure', () => {
    expect(deriveProbeHealthStatus('skipped', 401, 'Invalid API key')).toBe('failure');
    expect(deriveProbeHealthStatus('skipped', 403, 'Forbidden')).toBe('failure');
    expect(deriveProbeHealthStatus('skipped', 429, 'Rate limit')).toBe('failure');
  });

  it('skipped without httpStatus should be skipped', () => {
    expect(deriveProbeHealthStatus('skipped', null, '通道无有效探活令牌')).toBe('skipped');
  });

  it('5xx errors should be failure', () => {
    expect(deriveProbeHealthStatus('inconclusive', 502, 'Bad Gateway')).toBe('failure');
    expect(deriveProbeHealthStatus('inconclusive', 503, 'Service temporarily unavailable')).toBe('failure');
  });

  it('timeout should be failure', () => {
    expect(deriveProbeHealthStatus('inconclusive', null, 'Timeout after 15000ms')).toBe('failure');
  });

  it('true unknown should remain unknown', () => {
    expect(deriveProbeHealthStatus('inconclusive', 200, 'No response body')).toBe('unknown');
    expect(deriveProbeHealthStatus('inconclusive', 200, 'Stream ended immediately')).toBe('unknown');
  });
});
```

## 风险缓解

1. **行为回归**：修正派生规则，保持 `401/403/429` 沉底
2. **UI 分叉**：同时修改 RouteCard 和 SortableChannelRow
3. **路由影响**：明确说明取决于策略类型
4. **测试覆盖**：重点测试 `401/403/429` 和边界情况

## 实施检查清单

- [ ] 创建 `src/shared/probeHealthClassifier.ts`
- [ ] 编写单元测试，覆盖所有边界情况
- [ ] 修改 `tokens.ts` 排序逻辑
- [ ] 修改 `RouteCard.tsx` 统计逻辑
- [ ] 修改 `SortableChannelRow.tsx` badge 逻辑
- [ ] 运行所有测试
- [ ] 手动测试 UI 展示
- [ ] 验证 `401/403/429` 仍然沉底
- [ ] 验证 badge 和统计一致
- [ ] 提交代码

## 参考

- Codex 第一次评审：`docs/custom/plans/2026-04-04-probe-status-classification-revised.md`
- 影响分析（初版）：`docs/custom/plans/2026-04-04-probe-derived-classification-impact-analysis.md`
- Codex 第二次评审：本文档基于其反馈修正
