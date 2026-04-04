# 派生分类方案影响分析

**日期**: 2026-04-04
**目的**: 评估 Codex 建议的派生分类方案的实际影响范围

## 背景

Codex 建议使用派生分类方案：保留 raw status 不变，新增 `deriveProbeHealthStatus()` 函数将 4 态映射为展示层的 `success | failure | unknown | skipped`。

本文档分析该方案的实际影响范围和风险。

## 代码现状分析

### ✅ 无影响的部分（保持原有行为）

#### 1. 持久化逻辑（最关键）

**文件**: `src/server/services/modelAvailabilityScheduler.ts:26-27`
```typescript
if (result.status === 'supported') return true;
if (result.status === 'unsupported') return false;
```

**文件**: `src/server/routes/api/accountTokens.ts:98-99`
```typescript
if (result.status === 'supported') return true;
if (result.status === 'unsupported') return false;
```

**结论**: ✅ 不会改变，因为我们不修改 raw status。`supported → available=true`, `unsupported → available=false` 的语义保持不变。

#### 2. 后台任务和签到

**文件**:
- `src/server/services/backgroundTaskService.ts:233`
- `src/server/routes/api/checkin.ts:29,34,38`

```typescript
if (status === 'skipped' || item?.result?.skipped) { ... }
```

**结论**: ✅ 继续使用 raw status 判断 `skipped`，不受影响。

#### 3. OAuth 配额

**文件**: `src/server/services/oauth/quota.ts:97`
```typescript
const status = raw.status === 'supported' || raw.status === 'unsupported' || raw.status === 'error'
```

**结论**: ✅ 继续使用 raw status，不受影响。

### ⚠️ 需要修改的部分（使用派生结果）

#### 1. 前端统计展示

**文件**: `src/web/pages/token-routes/RouteCard.tsx:219-223`

**当前逻辑**（已经在做部分派生）:
```typescript
const routeProbeSupportedCount = results.filter(r => r.status === 'supported').length;
const routeProbeFailedCount = results.filter(r =>
  r.status === 'unsupported' || (r.status === 'skipped' && r.httpStatus != null)
).length;
const routeProbeUnknownCount = Math.max(0, effectiveProbeResults.length - routeProbeSupportedCount - routeProbeFailedCount);
```

**改为使用派生函数**:
```typescript
const routeProbeSupportedCount = results.filter(r => deriveHealth(r) === 'success').length;
const routeProbeFailedCount = results.filter(r => deriveHealth(r) === 'failure').length;
const routeProbeUnknownCount = results.filter(r => deriveHealth(r) === 'unknown').length;
```

**影响**:
- ✅ 正面：统计更准确，`502/503/timeout` 会被计入失败而非未知
- ✅ 正面：逻辑更清晰，不需要重复 `skipped && httpStatus != null` 的判断
- ⚠️ 变化：UI 上"失败"数量会增加，"未知"数量会减少

#### 2. 排序逻辑

**文件**: `src/server/routes/api/tokens.ts:602-608`

**当前逻辑**（已经在做部分派生）:
```typescript
const PROBE_RANKING_ERROR_HTTP_STATUS = new Set([401, 403, 429]);

if (item.status === 'unsupported' || (item.httpStatus != null && PROBE_RANKING_ERROR_HTTP_STATUS.has(item.httpStatus))) {
  unhealthy.push(channel);
} else if (item.status === 'supported') {
  healthy.push({ channel, item });
} else {
  uncertain.push(channel);
}
```

**改为使用派生函数**:
```typescript
const health = deriveHealth(item);
if (health === 'failure') {
  unhealthy.push(channel);
} else if (health === 'success') {
  healthy.push({ channel, item });
} else {
  uncertain.push(channel);
}
```

**影响**:
- ✅ 正面：`502/503/timeout` 的渠道会被沉底，不再参与路由
- ✅ 正面：逻辑统一，不需要维护 `PROBE_RANKING_ERROR_HTTP_STATUS` 列表
- ⚠️ 变化：更多渠道会被沉底（unhealthy），可能影响可用渠道数量

#### 3. 探活弹窗

**文件**: `src/web/components/ModelProbeModal.tsx:317-320,370-391`

**当前逻辑**:
```typescript
const supportedRows = finishedRows.filter((r) => r.status === 'supported');
const unsupportedRows = finishedRows.filter((r) => r.status === 'unsupported');
const inconclusiveRows = finishedRows.filter((r) => r.status === 'inconclusive');
const skippedRows = finishedRows.filter((r) => r.status === 'skipped');

// 颜色映射
if (status === 'supported') return '#22c55e';
if (status === 'unsupported') return '#ef4444';
if (status === 'inconclusive') return '#eab308';
if (status === 'skipped') return '#94a3b8';

// 文本映射
if (status === 'supported') return '支持';
if (status === 'unsupported') return '不支持';
if (status === 'inconclusive') return '待定';
if (status === 'skipped') return '跳过';
```

**需要决策**:
- 选项 A: 保持显示 raw status（用户习惯，详细信息）
- 选项 B: 改为显示 derived health（统一展示，更清晰）
- 选项 C: 同时显示两者（raw status + derived health badge）

**影响**:
- 选项 A: ✅ 无影响，用户看到的和之前一样
- 选项 B: ⚠️ 用户看到的标签会变化（"待定" → "失败"）
- 选项 C: ⚠️ UI 需要调整，但信息最全面

## 🎯 关键发现

### 好消息：代码中已经有部分"派生判断"的逻辑了！

1. **RouteCard.tsx:221**: 已经把 `skipped + httpStatus != null` 归为失败
2. **tokens.ts:602**: 已经把 `unsupported` 或特定 HTTP 状态码归为 unhealthy
3. **说明**: 派生分类的思路已经在局部使用，只是不够系统化

### 坏消息：当前的派生逻辑不一致

1. **PROBE_RANKING_ERROR_HTTP_STATUS = [401, 403, 429]** 只包含认证错误
2. **没有包含** `502/503/timeout` 等明确的运行时故障
3. **不同地方的判断逻辑不统一**，容易出现不一致的行为

## 📊 影响评估表

| 影响类型 | 影响范围 | 风险等级 | 正面/负面 | 说明 |
|---------|---------|---------|----------|------|
| 持久化 | 无影响 | 无 | ✅ 正面 | 不修改 raw status，核心语义不变 |
| 后台任务 | 无影响 | 无 | ✅ 正面 | 继续使用 raw status |
| 前端统计 | 需修改 | 低 | ✅ 正面 | 统计更准确，逻辑更清晰 |
| 排序逻辑 | 需修改 | 低-中 | ✅ 正面 | 故障渠道沉底，路由更可靠 |
| 探活弹窗 | 需决策 | 中 | ⚠️ 中性 | 取决于实施方式 |
| 代码一致性 | 改善 | 无 | ✅ 正面 | 统一现有的分散派生逻辑 |

## 💡 潜在风险

### 1. 可用渠道数量减少

**场景**: 如果大量渠道因为临时 `502/503` 被沉底，可能导致可用渠道不足。

**缓解措施**:
- 派生分类只影响展示和排序，不影响持久化
- 临时故障的渠道在下次探活成功后会自动恢复
- 可以通过监控观察沉底渠道数量

### 2. 用户习惯变化

**场景**: 用户习惯看到"待定"标签，突然变成"失败"可能造成困惑。

**缓解措施**:
- 探活弹窗保持显示 raw status（选项 A）
- 或者同时显示 raw status 和 derived health（选项 C）
- 在 UI 上添加说明文案

### 3. 测试覆盖

**场景**: 现有测试可能依赖特定的 status 分布。

**缓解措施**:
- 派生函数不改变 raw status，现有测试应该继续通过
- 需要为派生函数本身添加单元测试
- 需要更新依赖统计结果的集成测试

## 🎯 总体评估

### 正面影响（多）

1. ✅ **核心语义不变**: 持久化逻辑完全不受影响
2. ✅ **统计更准确**: `502/503/timeout` 正确归类为失败
3. ✅ **路由更可靠**: 故障渠道自动沉底
4. ✅ **代码更清晰**: 统一分散的派生逻辑
5. ✅ **易于维护**: 派生规则集中在一个函数
6. ✅ **向后兼容**: raw status 保持不变，可以渐进式迁移

### 负面影响（少）

1. ⚠️ **UI 变化**: 失败数量增加，未知数量减少（但这是预期的）
2. ⚠️ **沉底渠道增加**: 可能短期内可用渠道减少（但提高了可靠性）
3. ⚠️ **用户习惯**: 需要适应新的统计结果（可以通过文案缓解）

## 📋 实施建议

### 阶段 1: 核心实现（低风险）

1. 实现 `deriveProbeHealthStatus()` 函数
2. 添加单元测试
3. 修改 `RouteCard.tsx` 统计逻辑
4. 修改 `tokens.ts` 排序逻辑

### 阶段 2: 观察和调整（中风险）

1. 部署到生产环境
2. 监控沉底渠道数量
3. 收集用户反馈
4. 根据反馈调整派生规则

### 阶段 3: 完善展示（可选）

1. 决定探活弹窗的展示方式
2. 添加 UI 说明文案
3. 考虑同时显示 raw status 和 derived health

## 🤔 待 Codex 评审的问题

1. **总体评估**: 这个影响分析是否准确？有没有遗漏的影响点？
2. **风险评估**: 正面影响是否真的大于负面影响？
3. **实施优先级**: 是否应该先实施派生分类，还是考虑其他方案？
4. **渐进式迁移**: 是否可以先改统计/排序，探活弹窗保持原样？
5. **边界情况**: 派生规则是否覆盖了所有需要考虑的场景？

## 附录：派生函数示例

```typescript
function deriveProbeHealthStatus(
  status: 'supported' | 'unsupported' | 'inconclusive' | 'skipped',
  httpStatus: number | null,
  error: string | null
): 'success' | 'failure' | 'unknown' | 'skipped' {
  // 成功
  if (status === 'supported') return 'success';

  // 跳过（认证/限流问题）
  if (status === 'skipped') return 'skipped';

  // 明确的运行时故障
  if (httpStatus && httpStatus >= 500) return 'failure';
  if (error?.includes('Timeout after')) return 'failure';
  if (error?.includes('fetch failed')) return 'failure';
  if (error?.includes('Bad Gateway')) return 'failure';
  if (error?.includes('Service temporarily')) return 'failure';
  if (error?.includes('overload')) return 'failure';
  if (error?.includes('无可用渠道')) return 'failure';
  if (error?.includes('unknown provider')) return 'failure';
  if (error?.includes('<!DOCTYPE html>')) return 'failure';

  // 模型不支持
  if (status === 'unsupported') return 'failure';

  // 真正无法判断
  return 'unknown';
}
```

## 参考

- 原方案文档: `docs/custom/plans/2026-04-04-probe-status-classification-aggressive.md`
- 修正方案文档: `docs/custom/plans/2026-04-04-probe-status-classification-revised.md`
- Codex 第一次评审: 见修正方案文档
