# #365 Route Cooldown Controls — 审计补充版

> 基线文档：
> `/Users/chaos/.gemini/antigravity/brain/ec7a2002-7676-4e83-be19-2abd71379c9c/pr365_analysis.md.resolved`
>
> 校验时间：2026-04-02
>
> 处理方式：不改原文；本文件内容应视为“追加在原文末尾”的审计补充版。
>
> 审计范围：上游 PR #365 原始 PR 描述、files diff、review comments、当前
> `metapi` 仓库实现。

---

## 1. 一句话结论

Claude 文档的大方向是对的：

1. 可配置 `failureCooldownMaxSec`
2. route 级批量清冷却

但如果后续要真正落地到当前仓库，不能只抄这两个表面功能点。

原版 PR 二次复核后，至少还要把下面 4 个实现约束一起带上，否则很容易
变成“接口有了，但语义不对”。

---

## 2. 这次补充确认的 4 个关键约束

### 2.1 route 清冷却不能直接扫全量 `sourceRouteIds`

这点是 Claude 文档里遗漏的。

上游 PR review 后的最终实现已经改成：

- `explicit_group` route 清冷却时
- 只清当前真实展示的 `enabled exact source routes`
- 不能直接把所有 `sourceRouteIds` 都拿来清

原因：

- 否则会误清“当前 group 并没有真正暴露给管理员看到”的隐藏来源路由

这和本地当前展示逻辑是对齐的。

当前仓库里，`fetchChannelsForRouteRows()` 已经明确只把
`enabled + 非 explicit_group + exact model pattern` 的 source routes 当成
group 实际展示成员。

涉及位置：

- `src/server/routes/api/tokens.ts`

审计结论：

- 这一点应该采纳
- 而且要作为 route 级清冷却的硬约束，而不是可选优化

### 2.2 清 route/channel 冷却时，要同步清 runtime health

这点也是 Claude 文档里遗漏的。

上游 PR review 明确指出：

- 只清 `route_channels` 表里的
  `cooldownUntil / cooldownLevel / consecutiveFailCount / lastFailAt`
  还不够
- 如果 runtime 里还有 `site + model` 维度的 breaker / penalty
- 那么 UI 看起来“已解除冷却”
- 实际选择器仍然会继续避让这个通道

当前仓库也存在同类结构：

- `tokenRouter.ts` 里有 `siteModelRuntimeHealthStates`
- 并且会持久化到 `SITE_RUNTIME_HEALTH_SETTING_KEY`
- 现在的 `resetSiteRuntimeHealthForSite()` 已经是
  “runtime health + channel cooldown 一起清”

这已经从侧面证明：

- 当前项目的“冷却恢复”语义，本来就不是只动一张 `route_channels` 表

涉及位置：

- `src/server/services/tokenRouter.ts`
- `src/server/routes/api/tokens.ts`

审计结论：

- 如果新增 route 级批量清冷却
- 必须同步清受影响 `site + model` 的 runtime health 状态
- 否则管理员会看到“按钮成功”，但选路结果没有恢复

### 2.3 cooldown max 不能只改写路径，读路径也必须一起吃 cap

Claude 文档里提到了“要加 clamp”，但没把这个约束讲透。

上游 review 后的最终实现不是只在 `recordFailure()` 里限制
`cooldownUntil`，而是把 cap 统一下沉成共享逻辑，然后同时作用于：

- 写路径：写入 `cooldownUntil`
- 读路径：`isChannelRecentlyFailed()`
- 决策解释：最近失败避让说明

如果只改写路径，会出现一个表面上很隐蔽、但线上会很怪的问题：

1. DB 里的 `cooldownUntil` 看起来已经按配置上限截断了
2. 但读路径仍然按原始 fibonacci 窗口判断“最近失败”
3. 结果就是硬冷却时间过去以后，通道还是被继续避让

当前仓库现状：

- `resolveFailureBackoffSec()` 现在统一用了常量 `MAX_FAILURE_BACKOFF_SEC`
- `isChannelRecentlyFailed()` 直接吃 `resolveFailureBackoffSec(channel.consecutiveFailCount)`

这意味着如果以后把“30 天常量”改成运行时配置：

- 正确做法是继续复用同一套 helper
- 不能只在 `recordFailure()` 里单点改掉

涉及位置：

- `src/server/services/tokenRouter.ts`

审计结论：

- 这一点应该采纳
- 而且它是可配置冷却上限方案里最容易漏掉的 correctness 约束

### 2.4 前端 clear 成功后的刷新要 best-effort

这点不是核心后端逻辑，但属于很实用的管理体验修正。

上游 review 后把前端 clear 行为拆成了两段：

1. 先执行真正的清冷却 mutation
2. 再执行页面刷新 / decision refresh

这样能区分两种状态：

- 真正清除失败
- 已清除，但刷新失败

否则管理员会被误导，以为按钮没有生效，重复触发已经成功的管理动作。

当前仓库已有类似模式风险：

- `TokenRoutes.tsx` 的一些手工恢复动作，后面也会跟刷新/重载

审计结论：

- 如果后续加 route 级清冷却按钮
- 建议直接采纳这个前端交互细节

---

## 3. 一个需要单独确认的“本地语义差异”

这一点我不建议直接照搬上游。

### 上游最终实现

上游最终 `clearChannelFailureState()` 会一起清：

- `failCount`
- `lastFailAt`
- `consecutiveFailCount`
- `cooldownLevel`
- `cooldownUntil`

### 当前仓库现状

本地现在已有的两条恢复链路都没有清 `failCount`：

1. 单通道 `reset-cooldown`
2. 站点级 `reset-health`

它们只清：

- `lastFailAt`
- `consecutiveFailCount`
- `cooldownLevel`
- `cooldownUntil`

结合当前实现语义看：

- fibonacci 退避现在已经由 `consecutiveFailCount` 驱动
- `failCount` 更像长期统计 / 展示数据

这意味着：

- 在当前仓库里，`清冷却`
  不一定等于
  `清空历史失败统计`

如果直接照搬上游把 `failCount` 清零，会带来两个语义变化：

1. 管理动作顺手把历史观测值抹掉了
2. 当前已有单通道 / 站点恢复动作的语义会和新 route 恢复动作不一致

审计结论：

- 这里需要单独确认产品语义
- 在没确认前，我不建议直接把“清 `failCount`”列入可采纳项

---

## 4. 对 Claude 文档逐条审计后的修正版判断

### 4.1 可直接保留

1. 可配置 `failureCooldownMaxSec`
2. route 级批量清冷却
3. Settings UI 低优先级，可后续再做

### 4.2 需要补充后才成立

1. route 级清冷却
   - 必须补：
   - 只清 visible source routes
   - 同步清 runtime health
   - 清理 route / dependent explicit group decision snapshot

2. 可配置冷却上限
   - 必须补：
   - cap 同时覆盖写路径和读路径
   - 增加 settings/runtime 持久化与启动恢复
   - 增加边界测试

### 4.3 不建议照搬原文表述

1. “本地已有等效的通道重置逻辑，且含内存缓存同步”

这句话只对一部分成立。

原因：

- 本地站点级 reset 确实会 patch cache
- 但当前单通道 `reset-cooldown` 仍然是 `invalidateTokenRouterCache()`
- 更重要的是，本地目前没有“route 级 + runtime health 一起清”的等效能力

更准确的说法应是：

- 本地已有“单通道恢复”和“站点级恢复”
- 但还没有“符合当前项目语义的 route 级恢复”

2. “不需要引入 `routeCooldownService.ts` 独立服务层”

我认同“不需要原样照搬上游整个 service 拆分”。

但这里不适合再往前推成“最小共享恢复 helper”。

原因不是复用价值不够，而是三种恢复动作的 runtime health 语义本身就不同：

- `site` 级恢复：清整个 site 的 runtime health
- `route` 级恢复：只清受影响 channel 对应的 `site + model` runtime health
- `channel` 级恢复：如果后续补 runtime health 语义，也应只清该 channel 对应的
  `site + model`

这三者在“字段重置”上相似，但在 runtime health 清理粒度上并不统一。
如果为了复用强行抽成一个统一 helper，反而更容易把 `site` 级整站清理和
`route` 级定向清理混在一起，造成语义漂移。

因此更合适的做法是：

- route 级继续复用现有 `patchCachedChannel` 思路和 snapshot 清理链路
- runtime health 清理按 `site + model` 粒度独立实现
- site 级继续保留当前整站 reset 的独立实现

所以更准确的判断是：

- 不需要照搬完整 `routeCooldownService.ts`
- 也不建议为了复用再抽一个覆盖 channel / route / site 的统一恢复 helper

---

## 5. 建议实施顺序

### Phase A：后端 correctness 先行

范围：

- `src/server/config.ts`
- `src/server/index.ts`
- `src/server/routes/api/settings.ts`
- `src/server/services/tokenRouter.ts`

目标：

- 把 `MAX_FAILURE_BACKOFF_SEC` 变成可配置上限
- 保证 cap 同时覆盖写路径和读路径
- 完成 settings/runtime 持久化和启动恢复

### Phase B：route 级清冷却后端能力

范围：

- `src/server/routes/api/tokens.ts`
- `src/server/services/tokenRouter.ts`

目标：

- 新增 `POST /api/routes/:id/cooldown/clear`
- 只命中 visible source routes
- 同步清 runtime health
- 清 decision snapshots
- 保持本地现有恢复语义，不顺手改造 site 级 reset 结构

### Phase C：前端入口

范围：

- `src/web/api.ts`
- `src/web/pages/TokenRoutes.tsx`
- `src/web/pages/token-routes/RouteCard.tsx`

目标：

- 增加 route 级“清除冷却”按钮
- 刷新采用 best-effort
- toast 区分“清除失败”和“已清除但刷新失败”

### Phase D：Settings UI（可选）

范围：

- `src/web/pages/Settings.tsx`

目标：

- 仅在确认管理员确实需要频繁调上限时再做
- 否则环境变量 + runtime settings API 已经足够

---

## 6. 最终审计结论

如果只问“这份 Claude 文档的方向对不对”，答案是：

- **对**

如果问“能不能直接按这篇文档落代码”，我的答案是：

- **不能直接照搬**

最关键的补充结论有 5 条：

1. `explicit_group` 不能直接扫全量 `sourceRouteIds`
2. route/channel 清冷却必须同步清 runtime health
3. cooldown max 必须同时覆盖读写路径
4. 前端 clear 后刷新必须是 best-effort
5. `failCount` 是否应该一起清零，在当前仓库语义下需要单独确认，默认不建议照搬上游

另外还有一条结构性结论：

6. 不建议抽一个覆盖 channel / route / site 三类动作的统一恢复 helper；
   route 级 runtime health 应按 `site + model` 独立清理，site 级继续保持整站
   reset 语义

---

## 7. 实施后复审补充

在按本文落地代码后，又做了一轮实现级复审。结论如下。

### 7.1 已确认并修正的问题

1. `round_robin` 的 staged cooldown 不应受
   `tokenRouterFailureCooldownMaxSec` 影响。

原因：

- `weighted` / `stable_first` 使用的是 generic failure fibonacci 退避
- `round_robin` 使用的是独立的阶梯冷却
  `[10min, 1h, 24h]`

这两套语义不同。

如果把 `round_robin` 也走 generic cap，例如管理员把
`tokenRouterFailureCooldownMaxSec` 改成 4 小时，那么第 4 级
`24h` staged cooldown 会被错误截断成 `4h`。

因此最终实现保持为：

- generic failure cooldown 走 cap
- round-robin staged cooldown 不走 cap，继续按自身阶梯值生效

### 7.2 已复核但不采纳的问题

1. route 级清冷却不应改成仿 site 级的 `patchCachedChannel` 精确 patch。

表面上看，site 级 reset 现在会对每个 channel 调 `patchCachedChannel()`，
而 route 级 clear 最后只做 `invalidateTokenRouterCache()`，似乎不一致。

但这里不能机械照搬 site 级模式。

原因：

- route 级 clear 当前不是“等缓存 TTL 自然失效”，而是直接
  `invalidateTokenRouterCache()` 清空 `routeCacheSnapshot` 和
  `routeMatchCache`
- 下一次读取会立刻从 DB 重载，不存在“继续读到旧缓存 1.5 秒”的问题

更重要的是，当前 `patchCachedChannel()` 的实现只会 patch 第一个命中的
cached match。

而 route 级 clear 命中的 channel，可能同时出现在：

- source route 自己的 match
- 一个或多个 explicit_group route 的 match

如果这里强行改成逐个 `patchCachedChannel()`，反而会留下“部分 match 被更新、
部分 match 仍是旧值”的风险，比直接整包失效更不安全。

所以这轮复审后的最终判断是：

- route 级 clear 继续保持 `invalidateTokenRouterCache()` 即可
- 不应为了和 site 级表面一致，改成当前这个单命中语义的
  `patchCachedChannel()`
