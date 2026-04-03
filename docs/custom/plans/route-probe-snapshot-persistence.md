# 路由探活结果持久化方案：localStorage 快照 + 拓扑失效

> 本文档描述在路由界面留存上一次探活结果并标注时间的实现方案。
> 核心思路：探活完成后将结果序列化为 display-only 快照写入 localStorage，页面加载时恢复展示，不可触发"应用探活排序"操作。

---

## 背景与动机

当前探活结果仅存在于内存中的 `RouteProbeSession` state，刷新页面即丢失。用户完成探活后如果切换页面或刷新，无法回顾上次探活的结果和时间，不利于判断通道健康趋势和决定是否需要重新探活。

### 设计目标

1. **展示留存**：刷新页面后仍可看到上次探活结果摘要（时间、成功/失败/未知数、延迟统计）
2. **仅展示不可操作**：快照状态下"应用探活排序"按钮不可用，必须重新探活才能应用排序
3. **自动失效**：当路由的通道拓扑（enabled channel set）发生变化时，缓存的快照自动失效
4. **轻量实现**：纯前端 localStorage，不涉及后端 API 或数据库变更

### 参考实现

项目已有 `modelTesterSession.ts` 使用 localStorage 持久化模型测试会话的成熟模式（`metapi:model-tester-session` key，带版本号、序列化/反序列化、容错解析）。本方案沿用该模式。

---

## 核心类型设计

### `RouteProbeSnapshot`（新增）

与现有 `RouteProbeSession` 分离——`RouteProbeSession` 包含 `AbortController` 等不可序列化字段，且语义为"活跃探活会话"；`RouteProbeSnapshot` 是纯数据、display-only 的历史快照。

```typescript
// src/web/pages/token-routes/types.ts

/** 探活结果快照 — 仅用于展示，不可触发排序操作 */
export type RouteProbeSnapshot = {
  /** 探活完成时间（ISO 8601 字符串） */
  probedAt: string;
  /** 探活时的 enabled channel ID 集合（升序），用于拓扑失效判断 */
  channelFingerprint: readonly number[];
  /** 预期探测通道数 */
  expectedCount: number;
  /** 实际完成通道数（正常完成时等于 expectedCount，部分超时/异常时可能小于 expectedCount） */
  completedCount: number;
  /** 各通道探活结果 */
  results: Readonly<Record<number, ChannelProbeResult>>;
};
```

> **为什么用 `channelFingerprint: number[]` 而不是 hash？**
> - 通道数量一般 < 50，直接存 sorted ID 数组即可
> - 对比时用 `JSON.stringify(sorted)` 做全等比较，简单可靠
> - 避免引入额外的 hash 算法依赖

### `ChannelProbeResult`（复用现有）

```typescript
// 已有，无需修改
export type ChannelProbeResult = {
  channelId: number;
  status: ChannelProbeStatus;
  ttftMs: number | null;
  httpStatus: number | null;
  error: string | null;
};
```

---

## localStorage Schema

### 存储 Key

```
metapi:route-probe-snapshots
```

单一 key 存储所有路由的快照，值为 JSON 对象：

```typescript
type RouteProbeSnapshotStore = {
  version: 1;
  snapshots: Record<string, RouteProbeSnapshot>; // key = routeId (string)
};
```

> **为什么用一个 key 而非 per-route key？**
> - 路由数量有限（通常 < 200），整体序列化不会超出 localStorage 容量
> - 统一管理方便做版本迁移和全量清理
> - 与 `modelTesterSession` 模式一致（单 key + version）

### Key 类型注意事项

`JSON.stringify` 会将 number key 转为 string。因此：
- 存储层（`RouteProbeSnapshotStore`）的 `snapshots` key 是 `string`（`Record<string, RouteProbeSnapshot>`）
- 应用层（`loadRouteProbeSnapshots` 返回值）需要做 `parseInt(key, 10)` 转换回 `number`，对外提供 `Record<number, RouteProbeSnapshot>`
- `saveRouteProbeSnapshot` / `removeRouteProbeSnapshot` 接收 `number` 类型的 routeId，内部用 `String(routeId)` 作为存储 key

### 容量估算

- 每条 `ChannelProbeResult` ≈ 80 bytes JSON（不含 error 字段）
- `error` 字段可能包含长文本，**存储时截断到 200 字符**以控制体积
- 每个路由平均 10 通道 → 每个快照 ≈ 1 KB
- 200 个路由 → ≈ 200 KB，远低于 localStorage 5 MB 限制

---

## 模块设计

### 新增文件：`src/web/pages/helpers/routeProbeSnapshotStore.ts`

负责快照的序列化、反序列化、存取和失效判断。

#### 接口设计

```typescript
const STORAGE_KEY = 'metapi:route-probe-snapshots';
const STORE_VERSION = 1;

/** 从 localStorage 加载全部快照 */
export function loadRouteProbeSnapshots(): Record<number, RouteProbeSnapshot>;

/** 保存单个路由的快照到 localStorage */
export function saveRouteProbeSnapshot(routeId: number, snapshot: RouteProbeSnapshot): void;

/** 删除单个路由的快照 */
export function removeRouteProbeSnapshot(routeId: number): void;

/** 清除全部快照 */
export function clearAllRouteProbeSnapshots(): void;

/**
 * 根据当前 enabled channels 生成拓扑指纹
 * @returns sorted channel ID array
 */
export function buildChannelFingerprint(channels: RouteChannel[]): number[];

/**
 * 判断快照是否因拓扑变化而失效
 * @returns true = 拓扑已变，快照应丢弃
 */
export function isSnapshotStale(
  snapshot: RouteProbeSnapshot,
  currentChannels: RouteChannel[],
): boolean;
```

#### 实现要点

1. **`loadRouteProbeSnapshots`**：
   - `JSON.parse` with try-catch，解析失败返回空对象
   - 版本检查：`version !== STORE_VERSION` 时丢弃全部数据
   - 对每条 snapshot 做基本字段校验（`probedAt` 是有效日期字符串、`results` 是对象）

2. **`saveRouteProbeSnapshot`**：
   - 先 load 全量 → 插入/覆盖 → 整体 stringify 写回
   - 写入失败（QuotaExceeded）时 silently ignore，不影响正常功能
   - 对 `ChannelProbeResult.error` 字段做截断处理（限制 200 字符），避免超长错误信息膨胀存储
   - **注意**：read-modify-write 模式在多 Tab 场景下存在竞态条件，最后写入的 Tab 获胜（预期行为，代码注释中标注）

3. **`buildChannelFingerprint`**：
   - 过滤 `enabled === true` 的通道
   - 提取 `id`，升序排序
   - 返回 `number[]`

4. **`isSnapshotStale`**：
   - 对 `snapshot.channelFingerprint` 也做一次防御性排序后再比较（防止存储时排序异常导致误判）
   - `JSON.stringify([...snapshot.channelFingerprint].sort((a, b) => a - b)) !== JSON.stringify(buildChannelFingerprint(currentChannels))`

---

## 状态管理变更

### `TokenRoutes.tsx`

#### 新增 state

```typescript
const [routeProbeSnapshots, setRouteProbeSnapshots] = useState<Record<number, RouteProbeSnapshot>>({});
```

#### 初始化加载

在组件挂载时从 localStorage 加载快照：

```typescript
useEffect(() => {
  setRouteProbeSnapshots(loadRouteProbeSnapshots());
}, []);
```

#### 探活完成时保存快照

在 `handleProbeRouteChannels` 的流结束处（`done: true` 之后），将完成的 session 转换为 snapshot 并保存：

```typescript
// 在 stream 开始前，捕获当时的 enabled channel 列表（避免 stream 期间通道变化影响指纹）
const snapshotChannels = [...(channelsByRouteId[routeId] || [])];

// ... stream 处理 ...

// 在 stream 结束的回调中，done = true 之后
const snapshot: RouteProbeSnapshot = {
  probedAt: new Date().toISOString(),
  channelFingerprint: buildChannelFingerprint(snapshotChannels),
  expectedCount: session.expectedCount,
  completedCount: session.completedCount,
  results: { ...session.results },
};
saveRouteProbeSnapshot(routeId, snapshot);
setRouteProbeSnapshots((prev) => ({ ...prev, [routeId]: snapshot }));
```

#### 清除快照

`handleClearRouteProbeSession` 同时清除对应的 snapshot：

```typescript
const handleClearRouteProbeSession = useCallback((routeId: number) => {
  setRouteProbeSessions((prev) => {
    const next = { ...prev };
    delete next[routeId];
    return next;
  });
  // 同时清除 snapshot
  removeRouteProbeSnapshot(routeId);
  setRouteProbeSnapshots((prev) => {
    const next = { ...prev };
    delete next[routeId];
    return next;
  });
}, []);
```

#### 应用排序后清除快照

`handleApplyProbeRanking` 成功后也清除 snapshot（排序已应用，快照失去参考价值）：

```typescript
// 在 handleApplyProbeRanking 成功后
removeRouteProbeSnapshot(routeId);
setRouteProbeSnapshots((prev) => {
  const next = { ...prev };
  delete next[routeId];
  return next;
});
```

#### `invalidateProbeStateForRoute` 协调

现有的 `invalidateProbeStateForRoute` 在通道增删操作时被调用，会清除 session 和 channel probe results。在此函数中也同步清除对应路由的 snapshot：

```typescript
function invalidateProbeStateForRoute(routeId: number) {
  // ... 现有的 session / channelProbeResults 清除逻辑 ...
  // 新增：清除 snapshot
  removeRouteProbeSnapshot(routeId);
  setRouteProbeSnapshots((prev) => {
    const next = { ...prev };
    delete next[routeId];
    return next;
  });
}
```

> **原因**：通道增删必然改变拓扑，直接清除比等待 `isSnapshotStale` 被动检测更及时。

#### 全量清理协调

现有 `clearAllRouteProbeSessions` 在页面卸载或全量重建路由时被调用。在其调用点旁边也清理全部快照：

```typescript
clearAllRouteProbeSnapshots();
setRouteProbeSnapshots({});
```

#### 拓扑失效检查

不做全量轮询。在以下时机对单个路由做失效检查：

1. **路由卡片展开时**（channels 加载完成后）：如果对应 snapshot 存在且 `isSnapshotStale(snapshot, currentChannels)` 为 true，自动移除该 snapshot
2. **通道增删/启禁用操作完成后**：由 `invalidateProbeStateForRoute` 直接清除（见上方）

实现方式：使用 `useEffect` 监听 channels 变化，在回调中做失效检查：

```typescript
// 在 TokenRoutes.tsx 或渲染 RouteCard 的循环中
useEffect(() => {
  const snapshot = routeProbeSnapshots[route.id];
  if (!snapshot || !channels) return;
  if (isSnapshotStale(snapshot, channels)) {
    removeRouteProbeSnapshot(route.id);
    setRouteProbeSnapshots((prev) => {
      const next = { ...prev };
      delete next[route.id];
      return next;
    });
  }
}, [routeProbeSnapshots[route.id], channels]);
```

> **为什么用 `useEffect` 而不是 `useMemo`？**
> - React Strict Mode 下 `useMemo` 可能被执行两次
> - Concurrent features 下 `useMemo` 的执行次数不保证
> - `useMemo` 中做 localStorage 删除是反模式，即使它是幂等的
> - `useEffect` 语义更正确："当依赖变化时执行副作用"

#### 传递给 RouteCard

```typescript
<RouteCard
  // ... 现有 props
  routeProbeSession={routeProbeSessions[route.id]}
  routeProbeSnapshot={effectiveSnapshot}  // 新增
  // ...
/>
```

---

## UI 变更

### `RouteCard.tsx`

#### 新增 prop

```typescript
routeProbeSnapshot?: RouteProbeSnapshot;
```

#### 展示逻辑（三态）

探活信息区域的渲染逻辑从现有的二态（有 session / 无 session）扩展为三态：

| 状态 | 条件 | 展示内容 |
|------|------|----------|
| **活跃探活** | `routeProbeSession` 存在 | 现有行为不变（探活中/探活完成 + 实时结果 + 应用排序/清除按钮） |
| **历史快照** | 无 session，`routeProbeSnapshot` 存在 | 灰色信息条，展示时间 + 摘要 + 清除按钮 |
| **无数据** | 两者都不存在 | 不显示探活信息区域（现有行为） |

#### 历史快照 UI 设计

在现有探活信息区域的位置（line 571-623 之间），当 `!routeProbeSession && routeProbeSnapshot` 时展示：

```
┌────────────────────────────────────────────────────────┐
│  上次探活: 2024-01-15 14:30:22                    [清除] │
│  ✅ 5 成功  ❌ 2 失败  ❓ 1 未知  ⏱ 最快 320ms 平均 850ms │
└────────────────────────────────────────────────────────┘
```

- 背景色：比活跃探活更淡，使用 `color-mix(in srgb, var(--color-text-muted) 6%, transparent)` 灰色调
- 边框：`1px solid var(--color-border)` 普通边框（非 info 色）
- 时间格式：`toLocaleString()` 本地化显示，带固定选项避免跨浏览器差异：
  ```typescript
  new Date(snapshot.probedAt).toLocaleString(undefined, {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  ```
- 不显示"应用探活排序"按钮——快照不可操作
- "清除"按钮：点击后清除该路由的 snapshot（`removeRouteProbeSnapshot` + 更新 state）

#### 通道级结果展示

通道级探活结果存在三个来源，按优先级从高到低依次回退：

```typescript
// 三层优先级链：单通道实时结果 > 批量会话结果 > 历史快照结果
const channelProbeResult =
  channelProbeResults?.[channel.id]           // 1. 单通道探活（最新实时结果）
  ?? routeProbeSession?.results[channel.id]   // 2. 批量探活会话（活跃 session）
  ?? routeProbeSnapshot?.results[channel.id]; // 3. 历史快照（localStorage 持久化）
```

> **为什么需要三层？**
> - `channelProbeResults` 是用户对单个通道触发的实时探活结果，应始终优先展示
> - `routeProbeSession.results` 是当前批量探活会话的结果（内存中，刷新即丢失）
> - `routeProbeSnapshot.results` 是上一次完成的探活快照（localStorage 持久化，刷新后仍可展示）
> - 现有代码已使用前两层（`channelProbeResults || routeProbeSession.results`），本方案仅在末尾追加第三层

这样通道行也能显示上次探活的状态标记（supported/unsupported 图标等），但颜色可以做淡化处理以区分于活跃结果（可选，第一版先不做颜色区分，后续迭代）。

#### 摘要统计复用

现有的统计计算逻辑（lines 211-224）已经从 `routeProbeSession.results` 提取。改为统一从"有效结果源"提取：

```typescript
const effectiveProbeResults = routeProbeSession
  ? Object.values(routeProbeSession.results)
  : routeProbeSnapshot
    ? Object.values(routeProbeSnapshot.results)
    : [];
```

后续的 `routeProbeSupportedCount`、`routeProbeFailedCount` 等保持不变，只是数据源切换。

---

## 改动文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/web/pages/token-routes/types.ts` | **新增类型** | 添加 `RouteProbeSnapshot` 类型定义 |
| `src/web/pages/helpers/routeProbeSnapshotStore.ts` | **新增文件** | localStorage 存取、拓扑指纹、失效判断 |
| `src/web/pages/TokenRoutes.tsx` | **修改** | 新增 snapshot state、加载/保存/清除逻辑、传递 prop |
| `src/web/pages/token-routes/RouteCard.tsx` | **修改** | 新增 snapshot prop、三态展示逻辑、统计源切换 |

---

## 测试计划

### 单元测试：`routeProbeSnapshotStore.test.ts`（新增）

| 用例 | 验证内容 |
|------|----------|
| save + load 往返 | 保存后加载返回相同数据 |
| 多路由独立存取 | route 1 和 route 2 的快照互不影响 |
| remove 单个路由 | 删除后 load 不包含该路由，其他路由不受影响 |
| clearAll | 清除后 load 返回空对象 |
| 版本不匹配 | localStorage 中存有 version=0 的数据，load 返回空对象 |
| JSON 损坏 | localStorage 内容非法 JSON，load 返回空对象不抛异常 |
| QuotaExceeded 容错 | `setItem` 抛出 QuotaExceededError 时不影响正常功能 |
| routeId 类型一致性 | 存储时 number key 序列化为 string，加载时 `parseInt` 恢复为 number |
| buildChannelFingerprint | 仅包含 enabled 通道、升序排列 |
| buildChannelFingerprint — 空通道列表 | 传入空数组返回 `[]` |
| isSnapshotStale — 拓扑未变 | 通道集合不变时返回 false |
| isSnapshotStale — 通道增加 | 新增通道后返回 true |
| isSnapshotStale — 通道减少 | 删除通道后返回 true |
| isSnapshotStale — 通道禁用 | 通道从 enabled 变 disabled 后返回 true |
| isSnapshotStale — 防御性排序 | 即使 snapshot.channelFingerprint 未排序，仍能正确比较 |
| probedAt 校验 | `loadRouteProbeSnapshots` 对无效日期字符串的 snapshot 应丢弃 |
| error 字段截断 | `saveRouteProbeSnapshot` 将超长 error 截断到 200 字符 |

### 组件测试：`RouteCard.test.tsx`（追加）

| 用例 | 验证内容 |
|------|----------|
| 无 session 无 snapshot | 不显示探活信息区域 |
| 有 session 有 snapshot | 显示活跃 session 而非 snapshot |
| 无 session 有 snapshot | 显示快照信息（时间 + 统计） |
| 快照模式无"应用探活排序"按钮 | 确认按钮不存在 |
| 快照"清除"按钮 | 点击后调用 `onClearRouteProbeSnapshot` |
| 三层 probeResult 优先级 | `channelProbeResults` > `routeProbeSession.results` > `routeProbeSnapshot.results` |
| 快照统计正确性 | 快照模式下 supportedCount / failedCount / 延迟统计与 snapshot.results 一致 |
| 快照模式探活按钮文案 | 存在快照时探活按钮显示"重新探活"（可选，第一版可保持"探活"不变） |

---

## 边界情况处理

| 场景 | 处理方式 |
|------|----------|
| localStorage 不可用（隐私模式） | `saveRouteProbeSnapshot` silently fail，功能降级为无快照 |
| 探活未完成就刷新页面 | 不保存快照（只在 `done === true` 时保存） |
| 探活进行中存在旧快照 | 活跃 session 优先展示，快照被遮蔽 |
| 用户手动清除浏览器数据 | 等同于无快照，功能正常 |
| 多 Tab 同时操作 | 不做跨 Tab 同步（localStorage event 监听），各 Tab 独立 state，最后写入的 Tab 获胜 |
| 快照中的 channelId 在当前 channels 中不存在 | `isSnapshotStale` 会检测到拓扑变化，自动失效 |
| 路由被删除但 snapshot 残留 | 孤儿快照不影响功能（不会为不存在的 routeId 渲染 UI），下次 `clearAll` 或手动清除浏览器数据时清理 |

---

## 不做的事情

- **不做后端持久化**：探活快照是前端展示辅助，不需要写入数据库
- **不做跨设备同步**：localStorage 本身不跨设备，这是预期行为
- **不做快照过期时间**：仅靠拓扑变化失效，不设 TTL（通道不变则快照一直有效，用户随时可手动清除）
- **不做快照对比/趋势**：第一版只存最近一次，不做历史趋势分析
- **不做通道级颜色淡化**：快照模式下通道级探活图标与活跃模式样式相同，后续迭代可做区分

---

## 设计备注

### 版本策略：内部 version 字段 vs key 内嵌版本

`modelTesterSession.ts` 使用 key 内嵌版本号（`metapi:model-tester-session` 实际 key 为 `metapi:model-tester-session-v5`），版本升级时旧 key 自然成为孤儿。本方案选择在 JSON 内部设 `version: 1` 字段，原因：

- 快照数据体积更大（多路由），孤儿 key 残留浪费更多空间
- 内部版本号支持读取旧版本时主动清除，而非等待用户手动清理
- 两种方式都可行，这里选择内部版本只是为了减少孤儿 key

### 探活按钮文案

当快照存在时，"探活"按钮是否改为"重新探活"以暗示已有历史结果？第一版保持不变（按钮文案与现有一致），后续根据用户反馈决定是否调整。
