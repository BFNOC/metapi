# 探活状态分类优化 - Codex 评审后的修正方案

**日期**: 2026-04-04
**状态**: ❌ 原方案被 Codex 评审否决，需要重新设计

## 原方案问题

将 `5xx/timeout/network` 等错误从 `inconclusive` 改为 `unsupported`。

## Codex 评审结果

### 🚨 高风险问题

1. **语义破坏**：`unsupported` 在系统中有强语义，会持久化为 `available=false`，表示"模型不支持"。将临时的运行时故障（502/503/timeout）归为 `unsupported` 会导致：
   - 临时故障被固化为"模型不支持"
   - 破坏可用性持久化语义
   - 前端展示为"不支持"，文案失真

2. **影响范围评估错误**：原方案认为"低风险、不影响前端、向后兼容"，但实际上：
   - `unsupported` 会进入异常沉底桶
   - 影响排序和统计逻辑
   - 破坏现有测试契约

3. **语义混淆**：`502/503/timeout/fetch failed` 是 **operational failure**（运行时故障），不是 **model unsupported**（模型不支持）

### ✅ Codex 建议的替代方案

#### 方案 A：派生分类（最小改动）

保留 `modelProbeService.ts` 的四态 raw status，不改持久化语义。新增共享 helper 函数：

```typescript
// 新增派生分类函数
function deriveProbeHealthStatus(
  status: 'supported' | 'unsupported' | 'inconclusive' | 'skipped',
  httpStatus: number | null,
  error: string | null
): 'success' | 'failure' | 'unknown' | 'skipped' {
  if (status === 'supported') return 'success';
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

前端统计、badge、排序使用派生结果：
- `RouteCard.tsx` 的统计
- `SortableChannelRow.tsx` 的展示
- `tokens.ts` 的排序逻辑

#### 方案 B：新增第五态（语义更干净）

```typescript
export type ProbeResult = {
  modelName: string;
  status: 'supported' | 'unsupported' | 'failed' | 'inconclusive' | 'skipped';
  failureKind?: 'timeout' | 'network' | 'upstream_5xx' | 'config_error' | 'overload';
  // ...
};
```

持久化语义：
- `supported=true`
- `unsupported=false`
- `failed/inconclusive/skipped=null`

## 推荐方案

**采用方案 A（派生分类）**，理由：
1. 最小改动，不破坏现有持久化语义
2. 不需要修改类型定义和数据库
3. 前端可以立即使用派生结果改善展示
4. 保持 `unsupported` 的原有语义

## 实施步骤（修正版）

1. ✅ 编写计划文档（本文档）
2. ✅ Codex 评审（已完成）
3. ⬜ 实现 `deriveProbeHealthStatus` 函数
4. ⬜ 编写单元测试
5. ⬜ 修改前端统计逻辑使用派生结果
6. ⬜ 修改排序逻辑使用派生结果
7. ⬜ 运行测试验证
8. ⬜ 手动测试验证
9. ⬜ 提交代码

## 预期效果（修正版）

### UI 展示层
- ✅ 5 成功
- ❌ 28 失败（包含原来的 7 失败 + 21 运行时故障）
- ❓ 0 未知（只保留真正无法判断的情况）

### 持久化层
- `supported` → `available=true`
- `unsupported` → `available=false`（仅模型不支持）
- `inconclusive/skipped/failed` → 不修改 available 字段

## 关键差异

| 维度 | 原方案 | 修正方案 |
|------|--------|----------|
| 修改点 | 改 `modelProbeService.ts` 分类逻辑 | 新增派生函数，不改原分类 |
| `unsupported` 语义 | 扩展为"不可用" | 保持"模型不支持" |
| 持久化影响 | 破坏 available 语义 | 无影响 |
| 前端展示 | 直接使用 raw status | 使用派生 health status |
| 风险等级 | 高 | 低 |

## 参考

- Codex 评审结果：完整输出见上文
- 相关文件：
  - `src/server/services/modelProbeService.ts`
  - `src/server/routes/api/accountTokens.ts` (持久化逻辑)
  - `src/server/services/modelAvailabilityScheduler.ts`
  - `src/web/components/ModelProbeModal.tsx`
  - `src/web/pages/token-routes/RouteCard.tsx`
  - `src/web/pages/token-routes/SortableChannelRow.tsx`
