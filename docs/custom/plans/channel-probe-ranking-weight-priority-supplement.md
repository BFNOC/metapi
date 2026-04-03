# 探活排序补充方案：weight+priority 混合策略 & 自定义确认弹层

> 本文档是 [channel-probe-smart-ranking.md](./channel-probe-smart-ranking.md) 的补充修订，针对两个已确认的问题提出改进方案。

---

## 问题 1：全量改 priority 导致低优先级通道永远不被选中

### 现状

当前 `buildProbeRankingPriorityUpdates()` 将所有通道按探活结果逐个分配递增的 priority（0, 1, 2, 3...）：

```typescript
// tokens.ts:624-628 — 现有实现
return [...fast, ...normal, ...slow, ...uncertain, ...unhealthy]
  .map((channel, priority) => ({
    id: channel.id,
    priority,
  }));
```

### 问题

路由器的通道选择是 **priority 严格分层**（`tokenRouter.ts:2227`）：同一 priority 层内按 weight 加权随机选择，如果 P0 有可用通道则**永远不会访问 P1**。

全量递增 priority 的结果：
- P0 通道独占 100% 选中概率
- P1 及以后的通道选中概率为 0%
- 即使 P0 和 P1 通道的 TTFT 差距很小（如 200ms vs 300ms），P1 仍然完全不被选中

如截图所示：P0（权重 200）选中概率 100%，P1（权重 10）和 P2（权重 10）均为 0.0%。

### 修订方案：异常改 priority 沉底，健康改 weight 分流

**核心思路**：只用 priority 做"异常沉底"这一件事，健康通道之间的 TTFT 差异用 weight 表达，让它们在同一 priority 层内按加权概率共享流量。

#### 三段式修订

| 分类 | 判定条件 | priority 处理 | weight 处理 |
|------|---------|-------------|------------|
| **异常沉底** | `unsupported`，或 httpStatus ∈ {401, 403, 429} | 设为 `maxExistingPriority + 1`（统一沉底层） | 保持不变 |
| **健康分流** | `supported` 且 httpStatus 非错误码 | 保持原 priority 不变 | 按 TTFT 分档设置 weight |
| **不确定保守** | `inconclusive` / `skipped` 且非明确错误码 | 保持原 priority 不变 | 保持原 weight 不变 |

> **沉底层级基准**：`maxExistingPriority` 必须基于当前 route 下全部 enabled channels 的现有 priority 计算，不能只看健康/不确定通道。否则当用户已经手工维护了 `P5`、`P9` 等 fallback 层时，会把异常通道错误地“提升”回较浅层。

#### 健康通道 weight 分档

| 档位 | TTFT 范围 | weight 值 | 设计意图 |
|------|-----------|----------|---------|
| 快 | < 1000ms | 200 | 高概率被选中 |
| 正常 | 1000–3000ms | 100 | 中等概率 |
| 慢 | >= 3000ms | 30 | 低概率但仍可被选中 |

> **weight 语义**：路由器中的贡献计算为 `(weight + 10) * factor`，所以 weight=200 的通道相对于 weight=30 的通道，选中概率约为 210/40 ≈ 5.25 倍。慢通道仍有约 16% 的概率被选中（假设只有一快一慢），避免了 priority 分层下的"全或无"问题。

#### `buildProbeRankingPriorityUpdates` → `buildProbeRankingUpdates` 重构

函数签名从只返回 priority 变为返回 priority + weight：

```typescript
type ProbeRankingUpdate = {
  id: number;
  priority: number;
  weight: number;
};

function buildProbeRankingUpdates(
  channels: Array<typeof schema.routeChannels.$inferSelect>,
  ranking: ProbeRankingPayloadItem[],
): ProbeRankingUpdate[] {
  const rankingByChannelId = new Map(ranking.map((item) => [item.channelId, item]));
  const healthy: Array<{ channel: typeof schema.routeChannels.$inferSelect; item: ProbeRankingPayloadItem }> = [];
  const uncertain: Array<typeof schema.routeChannels.$inferSelect> = [];
  const unhealthy: Array<typeof schema.routeChannels.$inferSelect> = [];

  for (const channel of sortChannelsByCurrentPriority(channels)) {
    const item = rankingByChannelId.get(channel.id);
    if (!item) { uncertain.push(channel); continue; }

    if (item.status === 'unsupported'
        || (item.httpStatus != null && PROBE_RANKING_ERROR_HTTP_STATUS.has(item.httpStatus))) {
      unhealthy.push(channel);
    } else if (item.status === 'supported') {
      healthy.push({ channel, item });
    } else {
      uncertain.push(channel);
    }
  }

  // 健康通道：保持原 priority，按 TTFT 分档设 weight
  const healthyUpdates: ProbeRankingUpdate[] = healthy.map(({ channel, item }) => ({
    id: channel.id,
    priority: channel.priority ?? 0,
    weight: ttftToWeight(item.ttftMs),
  }));

  // 不确定通道：保持原 priority 和原 weight
  const uncertainUpdates: ProbeRankingUpdate[] = uncertain.map((channel) => ({
    id: channel.id,
    priority: channel.priority ?? 0,
    weight: channel.weight ?? 10,
  }));

  // 异常通道：priority 沉底到当前 route 的最大已有 priority + 1，weight 保持不变
  const maxExistingPriority = Math.max(
    0,
    ...channels.map((channel) => channel.priority ?? 0),
  );
  const sinkPriority = maxExistingPriority + 1;
  const unhealthyUpdates: ProbeRankingUpdate[] = unhealthy.map((channel) => ({
    id: channel.id,
    priority: sinkPriority,
    weight: channel.weight ?? 10,
  }));

  return [...healthyUpdates, ...uncertainUpdates, ...unhealthyUpdates];
}

function ttftToWeight(ttftMs: number | null): number {
  if (ttftMs == null) return 100; // 无 TTFT 数据视为正常档
  if (ttftMs < 1000) return 200;
  if (ttftMs < 3000) return 100;
  return 30;
}
```

#### `applyChannelPriorityUpdates` 扩展为支持可选 weight

现有的 `channelPriorityHelper.ts` 已经承载了事务写回、route snapshot 清理、dependent explicit-group snapshot 清理和 token router cache 失效。这里不再新建平行 helper，避免两个写回入口未来再次分叉。

改法改为：扩展现有 `applyChannelPriorityUpdates()`，让 update 项支持可选 `weight`；只有传了 `weight` 才写入 `route_channels.weight`，这样 `/api/channels/batch` 的旧语义保持不变，`apply-probe-ranking` 则可以复用同一套边界逻辑。

```typescript
export type ChannelPriorityUpdate = {
  id: number;
  priority: number;
  weight?: number;
};

export async function applyChannelPriorityUpdates(input: {
  existingChannels: Array<typeof schema.routeChannels.$inferSelect>;
  updates: ChannelPriorityUpdate[];
}): Promise<Array<typeof schema.routeChannels.$inferSelect>> {
  // ... 复用现有事务与快照/缓存清理逻辑
  await db.transaction(async (tx) => {
    for (const update of validUpdates) {
      const nextPatch: Record<string, unknown> = {
        priority: update.priority,
        manualOverride: true,
      };
      if (update.weight !== undefined) {
        nextPatch.weight = update.weight;
      }
      await tx.update(schema.routeChannels).set(nextPatch)
        .where(eq(schema.routeChannels.id, update.id)).run();
    }
  });
  // ... 原有 snapshot / cache 清理逻辑保持不变
}
```

> **注意**：`/api/channels/batch` 继续只传 `{ id, priority }`，不会改动 weight；`/api/routes/:routeId/channels/apply-probe-ranking` 才传 `{ id, priority, weight }`。

#### API 接口变更

`POST /api/routes/:routeId/channels/apply-probe-ranking` 的 response 不变，但内部调用改为复用已扩展的 `applyChannelPriorityUpdates`。

请求 body 不变——排序逻辑仍然在服务端计算，前端只提交原始探活数据。

#### 路由策略边界

- `weighted` / `stable_first`：健康通道的 weight 调整会直接影响同一 priority 层内的选路概率或稳定优先评分。
- `round_robin`：健康通道 weight 调整不参与选路；该策略下只有异常通道的 priority 沉底具备实际效果。
- 本期前端不因路由策略显示不同按钮或不同确认流程，但文档、测试和实现注释要把这个边界写清楚，避免误以为“调 weight 对所有策略都生效”。

---

## 问题 2：`window.confirm()` 原生确认框替换为自定义弹层

### 现状

`TokenRoutes.tsx:1158` 使用 `window.confirm()` 弹出确认框：

```typescript
const confirmed = window.confirm(
  '将异常通道沉底，健康通道按响应速度粗排（快/正常/慢三档），不确定通道保持原序。这是人工应急整理，不代表长期最优排序。'
);
```

### 问题

- 原生 `window.confirm()` 样式无法定制，与项目整体 UI 风格不一致
- 无法展示结构化内容（如分档说明、影响范围预览）
- 在部分移动端浏览器中表现不一致

### 修订方案：复用 `CenteredModal` 构建确认弹层

项目已有 `CenteredModal`（`src/web/components/CenteredModal.tsx`）和 `DeleteConfirmModal` 作为成熟的弹层基础设施。方案仿照 `DeleteConfirmModal` 的模式，在 `RouteCard.tsx` 中内联使用 `CenteredModal`。

#### 改动点

**`RouteCard.tsx`**：

1. 新增状态：
```typescript
const [showRankingConfirm, setShowRankingConfirm] = useState(false);
```

2. "应用探活排序"按钮的 onClick 从直接调用 `onApplyProbeRanking(routeId)` 改为打开弹层：
```typescript
onClick={() => setShowRankingConfirm(true)}
```

3. 在 RouteCard JSX 末尾添加确认弹层：
```tsx
<CenteredModal
  open={showRankingConfirm}
  onClose={() => setShowRankingConfirm(false)}
  title="应用探活排序"
  maxWidth={520}
  closeOnBackdrop
  footer={
    <>
      <button className="btn btn-ghost" onClick={() => setShowRankingConfirm(false)}>取消</button>
      <button
        className="btn btn-primary"
        onClick={() => {
          setShowRankingConfirm(false);
          onApplyProbeRanking?.(route.id);
        }}
      >
        确认应用
      </button>
    </>
  }
>
  <div style={{ fontSize: 13, lineHeight: 1.6 }}>
    <p>将根据探活结果调整通道配置：</p>
    <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
      <li><strong>异常通道</strong>（不可用/401/403/429）→ 优先级沉底</li>
      <li><strong>健康通道</strong> → 保持原优先级，按响应速度调整权重（快 200 / 正常 100 / 慢 30）</li>
      <li><strong>不确定通道</strong> → 保持原优先级和权重不变</li>
    </ul>
    <p style={{ color: 'var(--color-text-muted)' }}>
      这是人工应急整理，不代表长期最优配置。
    </p>
  </div>
</CenteredModal>
```

**`TokenRoutes.tsx`**：

移除 `handleApplyProbeRanking` 中的 `window.confirm()` 调用——确认逻辑已移到 RouteCard 弹层中，`handleApplyProbeRanking` 被调用时意味着用户已确认：

```typescript
const handleApplyProbeRanking = async (routeId: number) => {
  const session = routeProbeSessionsRef.current[routeId];
  if (!session || !session.done || session.completedCount !== session.expectedCount || session.expectedCount <= 0) {
    return;
  }
  // 移除 window.confirm() — 确认逻辑已由 RouteCard 的 CenteredModal 承担
  const ranking = Object.values(session.results).map((result) => ({
    channelId: result.channelId,
    ttftMs: result.ttftMs,
    status: result.status,
    httpStatus: result.httpStatus,
  }));
  // ... 后续逻辑不变
};
```

---

## 改动文件清单（增量）

| 文件 | 改动 |
|------|------|
| `src/server/routes/api/tokens.ts` | `buildProbeRankingPriorityUpdates` → `buildProbeRankingUpdates`，返回 priority + weight |
| `src/server/services/channelPriorityHelper.ts` | 扩展 `applyChannelPriorityUpdates()`，支持可选写入 weight，继续统一处理 snapshot / cache 清理 |
| `src/web/pages/TokenRoutes.tsx` | 移除 `window.confirm()` 调用 |
| `src/web/pages/token-routes/RouteCard.tsx` | 新增 `CenteredModal` 确认弹层 + `showRankingConfirm` 状态 |
| `src/web/pages/token-routes/RouteCard.test.tsx` | 新增确认弹层打开/取消/确认行为测试 |

---

## 确认弹层文案更新说明

因为排序策略从"全量改 priority"变为"异常改 priority + 健康改 weight"，确认弹层的文案也对应调整，不再提"三档粗排优先级"，改为说明 weight 分档的具体数值（200/100/30），让用户知道每个档位的权重差异。

---

## 测试补充

在 `tokens.channel-probe.test.ts` 中新增或修改用例：

| 用例 | 验证内容 |
|------|---------|
| 健康通道保持原 priority | 探活后健康通道的 priority 不变，只有 weight 被更新 |
| 异常通道 priority 沉底 | 异常通道的 priority = max(当前 route 全量 enabled channels priority) + 1 |
| 不确定通道保持原状 | priority 和 weight 均不变 |
| TTFT 分档 weight 值正确 | < 1000ms → 200, 1000-3000ms → 100, >= 3000ms → 30 |
| weight 写入落库 | 数据库中 weight 字段确实被更新 |
| 旧批量 priority 端点不受影响 | `/api/channels/batch` 仍只改 priority，不会误改 weight |
| `round_robin` 语义边界 | 仅验证异常沉底 priority 生效，不把健康 weight 变化当成必然影响选路的断言 |

在 `RouteCard.test.tsx` 中新增前端用例：

| 用例 | 验证内容 |
|------|---------|
| 点击“应用探活排序”先打开确认弹层 | 按钮不再直接调用 `onApplyProbeRanking` |
| 取消按钮/遮罩关闭 | 关闭弹层且不触发 `onApplyProbeRanking` |
| 确认按钮 | 关闭弹层并调用 `onApplyProbeRanking(route.id)` |
| 文案准确 | 弹层文案明确区分“异常改 priority、健康改 weight、不确定不变” |
