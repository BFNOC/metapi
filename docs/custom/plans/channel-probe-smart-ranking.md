# 通道探活与应急排序功能实施计划

## Context

当前 metapi 项目对单个路由可能有 30+ 个公益站上游通道，用户无法直观了解各通道的实际延迟和可用性。现有探活能力（站点级、令牌级、后台自动恢复）都不支持"对路由下所有通道批量探测并按性能排序"的场景。

**目标**: 新增路由级批量探活 + 单通道探活功能，收集 TTFT/延迟/成功状态，支持一键按性能应急排序通道优先级。

**业务定位**: 这是"人工触发的应急健康整队"，不是长期自动调度器。核心价值：
- 批量识别当前 route 下不健康 / 余额不足 / 限流 / 不可用的通道
- 让异常通道快速沉底，避免真实请求继续优先打到它们
- 对剩余健康通道做一次温和的人工辅助粗排，缩短应急恢复时间

**排序策略 — 三段式**（基于 `httpStatus` + `status` 组合判定）:
1. **异常沉底**: `unsupported`，或 httpStatus 为 401/403/429 的任何 status → 排最后
2. **健康粗排**: `supported` 且 httpStatus 非错误码 → 按 TTFT 分三档（快/正常/慢），同档内保留原 priority 顺序减少抖动
3. **不确定保守**: 其余（`inconclusive`/`skipped` 且非明确错误码）→ 保留原相对顺序，不前移也不沉底

> **注意**: `probeModels()` 会把 401/403 归为 `skipped`，timeout 归为 `inconclusive`。排序不能只看 `status` 字段，必须同时参考 `httpStatus` 来区分"403 的 skipped"和"无 token 的 skipped"。因此 `apply-probe-ranking` 的 payload 必须包含 `httpStatus`。

**`probeDisabled` 语义**: 跟现有手动 probe（`/api/sites/:id/probe-models`）对齐 —— 允许手动探活，不受 `probeDisabled` 限制。`probeDisabled` 仅约束后台自动恢复探测。同步修正仓库文档 `docs/custom/deployment-notes.md` 和 `docs/custom/feature-token-model-management.md` 中关于"手动探活被阻止"的过期描述。

---

## 改动文件清单

### 后端
| 文件 | 改动 |
|------|------|
| `src/server/routes/api/tokens.ts` | 新增 3 个 API 端点 |
| `src/server/services/channelProbeService.ts` | **新建** — 通道探活核心服务 |
| `src/server/services/channelPriorityHelper.ts` | **新建** — 从 `/api/channels/batch` 提取的共享 priority 写回逻辑 |

### 前端
| 文件 | 改动 |
|------|------|
| `src/web/api.ts` | 新增 3 个 API 方法 |
| `src/web/pages/token-routes/types.ts` | 扩展 Props 类型 |
| `src/web/pages/token-routes/SortableChannelRow.tsx` | 添加单通道探活按钮 + 结果展示 |
| `src/web/pages/token-routes/RouteCard.tsx` | 添加批量探活按钮 + 结果面板 + 应用排序按钮 |
| `src/web/pages/TokenRoutes.tsx` | 添加探活状态管理 + 回调函数 + props 传递 |

### 文档修正
| 文件 | 改动 |
|------|------|
| `docs/custom/deployment-notes.md` | 修正"手动探活被阻止"的过期描述 |
| `docs/custom/feature-token-model-management.md` | 同上 |

### 测试
| 文件 | 改动 |
|------|------|
| `src/server/routes/api/tokens.channel-probe.test.ts` | **新建** — 后端探活 API 测试 |

---

## Phase 1: 后端 — 通道探活服务

### 新建 `src/server/services/channelProbeService.ts`

提取并复用 `channelRecoveryProbeService.ts` 中的 token/model 解析逻辑，提供两个核心函数：

```typescript
// 1. 加载单个通道的探活所需信息
export async function loadChannelProbeCandidate(channelId: number): Promise<ChannelProbeCandidate | null>

// 2. 加载路由下所有通道的探活信息
export async function loadRouteChannelProbeCandidates(routeId: number): Promise<ChannelProbeCandidate[]>

export type ChannelProbeCandidate = {
  channelId: number;
  siteId: number;
  siteUrl: string;
  modelName: string;
  apiToken: string;
  extraConfig: string | null;
  site: typeof schema.sites.$inferSelect;
};
```

**复用链路**:
- `resolveRecoveryProbeTokenValue` 逻辑（从 channelRecoveryProbeService.ts:57-75 提取）
- `resolveRecoveryProbeModelName` 逻辑（从 channelRecoveryProbeService.ts:77-85 提取）
- `isUsableAccountToken`（from accountTokenService.ts:133）
- `getOauthInfoFromAccount`（from oauth/oauthAccount.ts）
- `resolveChannelProxyUrl` + `getDispatcherForProxyUrl`（from siteProxy.ts）
- `probeModels`（from modelProbeService.ts）
- `pickRandomProbePrompt`（from shared/probePrompts.ts）

**注意**: 不检查 `site.probeDisabled` — 手动探活不受此限制。

---

## Phase 2: 后端 — API 端点

在 `src/server/routes/api/tokens.ts` 末尾新增 3 个端点：

### 2.1 单通道探活

```
POST /api/channels/:channelId/probe
```

- 加载通道信息 → `loadChannelProbeCandidate(channelId)`
- 解析代理 → `resolveChannelProxyUrl(site, extraConfig)`
- 调用 `probeModels({ siteUrl, apiToken, modelNames: [modelName], ... })`
- 探活成功 → 调用 `tokenRouter.recordProbeSuccess(channelId, modelName)` 清除冷却
- 返回 `{ success, result: ProbeResult }`

### 2.2 路由级批量探活（SSE 流式）

```
POST /api/routes/:routeId/channels/probe
```

- **路由类型守卫**: 拒绝 `explicit_group`、`zero_channel`、`readOnly` 路由，返回 400
- 加载所有通道 → `loadRouteChannelProbeCandidates(routeId)`
- 对每个通道并发探活（concurrency 限制为 5）
- SSE 首帧发送 `{ type: "start", totalCount: N }` 告知前端预期总数
- 通过 SSE 流式返回每个通道的结果：
  ```
  data: {"type":"start","totalCount":30}
  data: {"type":"result","channelId":1,"status":"supported","ttftMs":234,"httpStatus":200,"error":null}
  data: {"type":"result","channelId":2,"status":"unsupported","ttftMs":null,"httpStatus":403,"error":"Forbidden"}
  data: [DONE]
  ```
- 探活成功的通道自动调用 `recordProbeSuccess` 清除冷却
- 支持客户端断开取消（`request.raw.on('close', ...)`)

### 2.3 按探活结果应用排序

```
POST /api/routes/:routeId/channels/apply-probe-ranking
Body: { ranking: Array<{ channelId: number; ttftMs: number | null; status: string; httpStatus: number | null }> }
```

**路由类型守卫**: 拒绝 `explicit_group`、`zero_channel`、`readOnly` 路由。

**服务端校验**:
- **归属校验**: body 中每个 `channelId` 必须属于该 `routeId`，否则 400。
- **完整集校验**: body 的 `channelId` 集合必须**完全等于**当前 route 的全部 enabled channel 集合，否则 400（message: "通道列表已变更，请重新探活"）。这防止通道增删后旧 ranking 部分落库造成优先级残缺。

**三段式排序逻辑**（基于 `httpStatus` + `status` 组合判定）:
1. **异常沉底**: `unsupported`，或 httpStatus 为 401/403/429 的任何 status → 排最后
2. **健康粗排**: `supported` 且 httpStatus 非错误码 → 按 TTFT 分三档
   - 快档：ttftMs < 1000ms
   - 正常档：1000ms <= ttftMs < 3000ms
   - 慢档：ttftMs >= 3000ms
   - 同档内保留原 `priority` 顺序
3. **不确定保守**: `inconclusive` / `skipped` → 保留原 `priority` 顺序，插在健康通道之后、异常通道之前

**Tie-breaker**: 同档 + 同 `ttftMs` → 按当前 `priority` 升序 → 再按 `channelId` 升序，确保幂等。

**事务写回**（复用共享 helper `applyChannelPriorityUpdates()`）:
- 从现有 `/api/channels/batch` 中提取 `applyChannelPriorityUpdates(routeId, updates[])` 到 `channelPriorityHelper.ts`，两个端点共享此逻辑，避免两套 priority 写回语义分叉
- 在一个事务中更新所有通道的 `priority` 和 `manualOverride = true`
- 清理 route decision snapshot + dependent explicit-group snapshots
- `invalidateTokenRouterCache()`
- 返回 `{ success, updatedCount }`

---

## Phase 3: 前端 — API 层

在 `src/web/api.ts` 的 `api` 对象中新增：

```typescript
// 单通道探活
probeChannel: (channelId: number) =>
  request(`/api/channels/${channelId}/probe`, { method: 'POST', timeoutMs: 30_000 }),

// 路由批量探活 (SSE 流式)
probeRouteChannelsStream: (
  routeId: number,
  onResult: (r: unknown) => void,
  signal?: AbortSignal,
) => streamProbeResults(`/api/routes/${routeId}/channels/probe`, {}, onResult, signal),

// 应用探活排序
applyProbeRanking: (
  routeId: number,
  ranking: Array<{ channelId: number; ttftMs: number | null; status: string; httpStatus: number | null }>,
) => request(`/api/routes/${routeId}/channels/apply-probe-ranking`, {
    method: 'POST',
    body: JSON.stringify({ ranking }),
  }),
```

---

## Phase 4: 前端 — 状态管理（TokenRoutes.tsx）

### 4.1 类型定义

```typescript
type ChannelProbeResult = {
  channelId: number;
  status: 'supported' | 'unsupported' | 'inconclusive' | 'skipped';
  ttftMs: number | null;
  httpStatus: number | null;
  error: string | null;
};

type RouteProbeSession = {
  controller: AbortController;
  expectedCount: number;
  completedCount: number;
  done: boolean;
  results: Record<number, ChannelProbeResult>;
};
```

### 4.2 状态

```typescript
// 单通道探活
const [probingChannelIds, setProbingChannelIds] = useState<Set<number>>(new Set());
const [channelProbeResults, setChannelProbeResults] = useState<Record<number, ChannelProbeResult>>({});

// 路由批量探活 — 带完整会话状态
const [routeProbeSessions, setRouteProbeSessions] = useState<Record<number, RouteProbeSession>>({});
```

### 4.3 回调函数

**单通道探活**:
```typescript
const handleProbeChannel = async (channelId: number) => {
  setProbingChannelIds(prev => new Set(prev).add(channelId));
  try {
    const res = await api.probeChannel(channelId);
    setChannelProbeResults(prev => ({ ...prev, [channelId]: res.result }));
    if (res.result.status === 'supported') {
      toast.success(`探活成功 — TTFT ${res.result.ttftMs}ms`);
      // 复用 handleResetChannelCooldown 的刷新模式
    } else {
      toast.warning(`探活结果: ${res.result.status} — ${res.result.error || ''}`);
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '探活失败');
  } finally {
    setProbingChannelIds(prev => { const next = new Set(prev); next.delete(channelId); return next; });
  }
};
```

**路由批量探活**（含会话管理）:
```typescript
const handleProbeRouteChannels = async (routeId: number) => {
  // 先 abort 同 route 旧会话
  const oldSession = routeProbeSessions[routeId];
  if (oldSession?.controller) oldSession.controller.abort();

  const controller = new AbortController();
  const session: RouteProbeSession = {
    controller,
    expectedCount: 0,
    completedCount: 0,
    done: false,
    results: {},
  };
  setRouteProbeSessions(prev => ({ ...prev, [routeId]: session }));

  try {
    await api.probeRouteChannelsStream(routeId, (raw: any) => {
      if (raw.type === 'start') {
        setRouteProbeSessions(prev => ({
          ...prev,
          [routeId]: { ...prev[routeId], expectedCount: raw.totalCount },
        }));
      } else if (raw.type === 'result') {
        setRouteProbeSessions(prev => {
          const s = prev[routeId];
          return {
            ...prev,
            [routeId]: {
              ...s,
              completedCount: s.completedCount + 1,
              results: { ...s.results, [raw.channelId]: raw },
            },
          };
        });
      }
    }, controller.signal);
    // SSE 正常结束 = done
    setRouteProbeSessions(prev => ({
      ...prev,
      [routeId]: { ...prev[routeId], done: true },
    }));
    toast.success('批量探活完成');
    // 注意：此处不调用 loadChannels — 避免触发 probeSession 作废逻辑
    // 通道列表刷新延迟到用户点击"应用探活排序"成功之后
  } catch (e) {
    if (controller.signal.aborted) return;
    toast.error(e instanceof Error ? e.message : '批量探活失败');
  }
};
```

**应用排序**（仅在 `done && completedCount === expectedCount` 时允许）:
```typescript
const handleApplyProbeRanking = async (routeId: number) => {
  const session = routeProbeSessions[routeId];
  if (!session?.done || session.completedCount !== session.expectedCount) return;
  const ranking = Object.values(session.results).map(r => ({
    channelId: r.channelId,
    ttftMs: r.ttftMs,
    status: r.status,
    httpStatus: r.httpStatus,
  }));
  try {
    await api.applyProbeRanking(routeId, ranking);
    toast.success('已应用探活排序');
    loadChannels(routeId, true).catch(() => {});
    loadRouteDecisions(routeSummaries, { force: true, persistSnapshots: true }).catch(() => {});
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '排序失败');
  }
};
```

**组件 unmount 清理**: 在 useEffect 中统一 abort 所有活跃 session controller。

**probeSession 作废规则**:
- 开始新一轮 probe 时清旧结果（已在 `handleProbeRouteChannels` 中实现）
- 组件 unmount 时 abort + 清除
- 外部非探活触发的通道列表变更（如添加/删除通道、rebuild 等）清除对应 routeId 的 probeSession
- 判定方式：在 `loadChannels` 外包一层，只有**非探活流程发起的调用**才清除 probeSession。具体实现：探活流程内部不直接调 `loadChannels`，仅在"应用排序"成功后才调用，此时已经消费完结果可以安全清除

### 4.4 Props 传递到 RouteCard

```typescript
<RouteCard
  // ... 现有 props ...
  onProbeRouteChannels={stableProbeRouteChannels}
  routeProbeSession={routeProbeSessions[route.id]}
  onApplyProbeRanking={stableApplyProbeRanking}
  onProbeChannel={stableProbeChannel}
  probingChannelIds={probingChannelIds}
  channelProbeResults={channelProbeResults}
/>
```

---

## Phase 5: 前端 — RouteCard UI

### 5.1 RouteCard 新增 Props

```typescript
onProbeRouteChannels?: (routeId: number) => void;
routeProbeSession?: RouteProbeSession;
onApplyProbeRanking?: (routeId: number) => void;
onProbeChannel?: (channelId: number) => void;
probingChannelIds?: Set<number>;
channelProbeResults?: Record<number, ChannelProbeResult>;
```

### 5.2 按钮显示条件

批量探活 / 应用排序按钮**仅对以下路由开放**：
- 非 `explicit_group`
- 非 `zero_channel`
- 非 `readOnly`
- 非 `isVirtual`

单通道探活按钮不受此限制，任何通道都可以单独探活。

### 5.3 批量探活按钮

位置：在"添加通道"按钮旁边（RouteCard.tsx ~第 510 行附近）

```
[重置优先级] [批量探活] [+ 添加通道]
```

- 探活中显示 spinner + 进度 "探活中 (12/30)..."
- 探活完成后显示结果摘要 + "应用探活排序"按钮

### 5.4 探活结果摘要

在通道列表上方，批量探活完成后显示：

```
探活完成：✅ 25 成功  ❌ 3 失败  ❓ 2 未知  ⏱ 最快 128ms / 平均 342ms
[应用探活排序] [清除结果]
```

- "应用探活排序"按钮：仅在 `done === true && completedCount === expectedCount` 时可点击
- 点击后弹确认提示："将异常通道沉底，健康通道按响应速度粗排（快/正常/慢三档），不确定通道保持原序。这是人工应急整理，不代表长期最优排序。"
- "清除结果"：清空该 routeId 的 probeSession

### 5.5 SortableChannelRow 单通道探活

**新增 Props**:
```typescript
onProbeChannel?: (channelId: number) => void;
probingChannel?: boolean;
probeResult?: ChannelProbeResult;
```

**UI**: 在通道行的状态区域（选中概率、成功/失败计数旁边）添加：

- **探活按钮**: `ActionPillButton` variant="info"，label="探活"
- **探活中**: 按钮变成 spinner
- **探活结果 badge**:
  - 成功 → 绿色 `✅ 234ms`
  - 失败 → 红色 `❌ 403`
  - 不确定 → 灰色 `❓ timeout`
- 结果在下次探活或页面刷新前持续显示

---

## 验证方案

### 后端自动化测试

新增 `src/server/routes/api/tokens.channel-probe.test.ts`，覆盖：
- 单通道探活成功后自动清冷却
- 路由级 SSE 探活逐条回传结果 + `[DONE]`
- `apply-probe-ranking` 的 route ownership 校验（非法 channelId → 400）
- `apply-probe-ranking` 的完整集校验（缺少/多余 channelId → 400）
- `apply-probe-ranking` 写回 `manualOverride = true`
- snapshot / cache 失效验证
- `explicit_group` 路由调用批量探活 / 应用排序 → 400 拒绝

### 后端手动测试
1. `curl -X POST localhost:PORT/api/channels/:id/probe` 验证单通道探活
2. `curl -X POST localhost:PORT/api/routes/:id/channels/probe -H "Accept: text/event-stream"` 验证 SSE 流式
3. 验证探活成功后冷却状态清除

### 前端测试
1. 展开路由卡片 → 看到"批量探活"按钮
2. 点击"批量探活" → 观察实时进度 + 每个通道探活结果
3. 完成后点击"应用探活排序" → 确认弹框 → 通道按三段式重排
4. 中途中断探活 → "应用探活排序"按钮不可点击
5. 点击单个通道"探活" → 独立显示结果
6. 冷却中通道探活成功 → 冷却自动解除
7. `explicit_group` 路由 → 不显示批量探活 / 排序按钮，但单通道探活仍可用

### 边界情况
- 通道无有效 token → 跳过，结果标记 `skipped`
- 客户端中途断开 → 后端停止剩余探活
- 并发控制 → 同一路由最多 5 个通道并发探测
- 重复点击 → abort 旧会话，启动新一轮
- 探活期间外部刷新通道列表 → 旧结果作废
- 通道增删后旧 ranking 提交 → 服务端 400 拒绝（完整集校验）

---

## 审查记录

> 以下为 2026-04-03 审查意见的原文归档，相关决策已合并到上方各 Phase 正文中。

<details>
<summary>审查补充原文（2026-04-03）</summary>

### 1. 明确路由范围：`explicit_group` 不能直接套用"当前卡片一键排序"

- 当前 `GET /api/routes/:id/channels` 对 `explicit_group` 返回的是来源路由通道投影，通道记录里的 `routeId` 仍然是来源路由，不是群组路由本身。
- **决策**: 批量探活 / 排序按钮仅对非 `explicit_group`、非 `zero_channel`、非 `readOnly` 路由开放。单通道探活不受限。

### 2. 排序写回必须带路由归属校验、事务和 `manualOverride=true`

- **决策**: 已纳入 Phase 2.3，包含归属校验、事务、`manualOverride`、稳定 tie-breaker。

### 3. 前端不能把中断的 SSE 半成品当成可应用排序的完整结果

- **决策**: 新增 `RouteProbeSession` 类型追踪 `{ controller, expectedCount, completedCount, done }`。仅在 `done && completedCount === expectedCount` 时允许排序。SSE 首帧发送 `totalCount`。

### 4. `probeDisabled` 的行为要先统一

- **决策**: 跟现有手动 probe 对齐，允许手动探活，不受 `probeDisabled` 限制。

### 5. 验证方案还需要补自动化测试落点

- **决策**: 已纳入验证方案，新增 `tokens.channel-probe.test.ts`。

### 6. 业务目标应改写为"异常沉底优先，健康粗排其次"

- **决策**: 已更新 Context 中的业务定位描述。

### 7. 建议把排序策略改成"两段式"

- **决策**: 已改为三段式（异常沉底 → 健康粗排分三档 → 不确定保守），纳入 Phase 2.3。

### 8. UI 交互建议从"单按钮智能排序"调整为更贴场景的表达

- **决策**: 按钮文案改为"应用探活排序"，点击后弹确认提示说明三段式逻辑。

</details>

<details>
<summary>Codex Review 修复记录（2026-04-03）</summary>

### Finding 1（严重）：排序协议自相矛盾 — status 词表 + payload 不匹配

- **问题**: `probeModels()` 把 401/403 归为 `skipped`、timeout 归为 `inconclusive`，但方案要求这些"沉底"，同时又说 `skipped`/`inconclusive` "保守保序"。`apply-probe-ranking` payload 只传 `status`，没有 `httpStatus`，服务端无法区分"403 的 skipped"和"无 token 的 skipped"。
- **修复**: payload 增加 `httpStatus` 字段。排序逻辑改为基于 `httpStatus` + `status` 组合判定。已更新 Phase 2.3、Phase 3、Phase 4.3。

### Finding 2（严重）：loadChannels 触发源冲突 — 探活完刷新会清掉自己的结果

- **问题**: 探活结束后调 `loadChannels(routeId, true)` 刷新通道，同时又规定"外部 loadChannels 清除 probeSession"，结果自己把自己清了，用户看不到"应用探活排序"按钮。
- **修复**: 探活完成后不主动调 `loadChannels`，仅在"应用探活排序"成功后才刷新。作废规则改为：只有非探活流程发起的 loadChannels 才清除 probeSession。已更新 Phase 4.3。

### Finding 3（中）：apply-probe-ranking 缺完整集校验

- **问题**: 只校验 channelId 归属，不要求覆盖完整 channel 集。外部新增/删除通道后旧 ranking 仍可能部分落库。
- **修复**: 服务端要求 body 的 channelId 集合必须完全等于当前 route 的全部 enabled channel 集合，否则 400。已更新 Phase 2.3。

### Finding 4（中）：重复的 priority 写回路径

- **问题**: 新增 `apply-probe-ranking` 与现有 `/api/channels/batch` 做几乎同类的 priority 写回，容易一边补逻辑另一边漏掉。
- **修复**: 从 `/api/channels/batch` 提取共享 helper `applyChannelPriorityUpdates()` 到 `channelPriorityHelper.ts`，两个端点共用。已更新改动文件清单和 Phase 2.3。

### Open Question：probeDisabled 文档不一致

- **问题**: 计划写"手动 probe 放行"，与代码行为一致，但 `docs/custom/deployment-notes.md` 和 `docs/custom/feature-token-model-management.md` 仍写"手动探活被阻止"。
- **修复**: 同一个 PR 修正这两处文档。已加入改动文件清单。

</details>
