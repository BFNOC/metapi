# #330 主动探活 + 负载感知稳定路由 — 当前仓库校正版实施顺序

> 基线文档：`/Users/chaos/.gemini/antigravity/brain/615de0d0-1ffe-4f61-a593-904e8242cca2/implementation_plan.md.resolved`
>
> 校验时间：2026-04-02
>
> 处理方式：不改原文；本文件内容应视为“追加在原文末尾”的校正版。
>
> 目标：基于当前 `metapi` 仓库现状，重排真正需要做的实现顺序，避免重复实现已经存在的能力。

---

## 1. 现状校验结论

这部分基于当前仓库代码，而不是旧方案假设。

1. `stable_first` 已经存在，不是待新增能力。
   - 后端已在 `src/server/services/tokenRouter.ts` 中实现。
   - 前端路由策略 UI 已在 `src/web/pages/TokenRoutes.tsx` 和
     `src/web/pages/token-routes/RouteCard.tsx` 中提供。

2. 原方案里把路由策略 UI 写到 `Settings.tsx` 不准确。
   - 当前仓库的“weighted / round_robin / stable_first”切换入口已经在
     Token Routes 页面。
   - 如果后续要新增“负载感知开关 / 自动恢复探测开关”，才需要接到
     `src/server/routes/api/settings.ts` + `src/web/pages/Settings.tsx`
     这条运行时设置链路。

3. `ModelProbeModal` 的实际路径是
   `src/web/components/ModelProbeModal.tsx`，不是 `src/web/pages/...`。

4. 当前 probe 仍然是三态，不是四态。
   - `src/server/services/modelProbeService.ts` 仍然返回
     `'ok' | 'timeout' | 'error'`。
   - `src/web/components/ModelProbeModal.tsx` 也仍然按三态渲染。

5. 后端默认 probe prompt 仍然是 `'hi'`，而且不只一处。
   - `src/server/routes/api/accountTokens.ts` 的 SSE 和非 SSE 路径都在用。
   - `src/server/routes/api/sites.ts` 的 SSE 和非 SSE 路径也在用。
   - 如果要做“反探测友好”的恢复 probe，这个默认值必须先收敛成共享
     prompt 库。

6. `accountTokens.ts` 已经把 probe 结果落到
   `token_model_availability` / `model_availability`，但语义还是
   `r.status === 'ok'`。
   - 这意味着四态改造不是只改 service，还要改持久化回写语义。

7. `proxyChannelCoordinator.ts` 已经有运行时状态来源。
   - `channelRuntimeStates` 里已经维护了 `activeLeaseIds` 和 `queue`。
   - 但现在没有对外暴露 `getChannelLoadSnapshot()` /
     `getActiveChannelIds()` 这种读接口，所以 tokenRouter 还拿不到稳定的
     负载快照。

8. `tokenRouter.recordSuccess()` 已经会清冷却并恢复运行时健康。
   - 但它还会累加 `successCount`、`totalLatencyMs`、`totalCost`。
   - 所以后台“恢复探测成功”不能直接复用 `recordSuccess()`，需要单独的
     `recordProbeSuccess()` 之类方法，只做恢复，不污染业务统计。

---

## 2. 重排原则

1. 不重复做已经存在的 `stable_first` 和路由策略 UI。

2. 先统一 probe 语义，再做恢复闭环。
   - 否则后台恢复任务拿到的仍然是旧三态，无法安全地区分
     `unsupported` 和网络抖动。

3. 先把负载信号接进现有的 `calculateWeightedSelection()`，再考虑是否把
   现有 `stable_first` 升级成“主池 / 观察池”。
   - 当前仓库已经在线使用 `stable_first`。
   - 观察池逻辑属于行为升级，不应和基础负载乘子、四态 probe 混成一批。

4. 后台恢复探测必须复用站点代理解析。
   - 手动 probe 的 account token 路径已经会根据站点 / 账号配置生成
     `Dispatcher`。
   - 后台任务如果绕过这条链路，线上行为会和手动 probe 不一致。

---

## 3. 精确实施顺序

### Phase 0：共享 probe prompt 基线

这是四态 probe 和后台恢复探测的共同前置。

范围：

- 新增 `src/shared/probePrompts.ts`
- 修改 `src/web/components/ModelProbeModal.tsx`
- 修改 `src/server/routes/api/accountTokens.ts`
- 修改 `src/server/routes/api/sites.ts`

产出：

- 前后端统一使用同一套“看起来像真实请求”的 prompt 池。
- 当用户未显式传 `prompt` 时：
  - Web 端探活默认使用共享随机 prompt
  - account token probe 使用共享随机 prompt
  - site probe 使用共享随机 prompt
- 保留“用户显式填写 prompt 时优先使用用户输入”的现有行为。

说明：

- 这一步先做，是为了把原方案里零散的“反探测”要求收敛成一个单一事实源。
- 做完后，后续 Phase 1 / Phase 3 都不再继续散落 `'hi'` 默认值。

### Phase 1：四态 probe 端到端改造

范围：

- 修改 `src/server/services/modelProbeService.ts`
- 修改 `src/server/routes/api/accountTokens.ts`
- 修改 `src/server/routes/api/sites.ts`
- 修改 `src/web/components/ModelProbeModal.tsx`

状态语义建议：

- `supported`
  - HTTP 2xx 且收到有效流数据
- `unsupported`
  - HTTP 404
  - 明确的 model not found / unsupported model / does not exist 类错误
- `inconclusive`
  - timeout
  - 5xx
  - 连接失败 / DNS / TLS / 代理链路异常
  - 空流 / 无 body / 提前结束但没有得到有效结果
- `skipped`
  - 401 / 403 / 429
  - 客户端主动断开

回写语义：

- `accountTokens.ts`
  - `supported` -> `available = true`
  - `unsupported` -> `available = false`
  - `inconclusive` / `skipped` -> 不覆盖既有 `available`
- `model_availability` 的账号级合并仍然只提升 `supported` 结果。
- 自动 route rebuild 仍然只针对 `supported` 模型触发。
- `sites.ts` 只负责回传四态结果，不做额外持久化。

验证建议：

- 新增 `src/server/services/modelProbeService.test.ts`
- 新增 `src/server/routes/api/accountTokens.probe-models.test.ts`

### Phase 2：Coordinator 负载快照 + 现有选路器接入负载乘子

这一步不是“新增 stable_first”，而是把负载信号接入已经存在的
`weighted` / `stable_first` 共用选路器。

范围：

- 修改 `src/server/services/proxyChannelCoordinator.ts`
- 修改 `src/server/services/proxyChannelCoordinator.test.ts`
- 修改 `src/server/services/tokenRouter.ts`
- 修改 `src/server/services/tokenRouter.selection.test.ts`

实现重点：

- 在 `proxyChannelCoordinator.ts` 暴露：
  - `ProxyChannelLoadSnapshot`
  - `getChannelLoadSnapshot(channelId, extraConfig?)`
  - `getActiveChannelIds()`
- 在 `tokenRouter.ts` 的 `calculateWeightedSelection()` 中新增
  `computeChannelLoadFactor(...)`。
- 负载乘子应叠加在当前已有的：
  - 站点权重
  - 运行时健康乘子
  - 历史健康乘子
 之后，而不是另起一套平行选路器。

收益：

- `weighted` 获得更合理的拥塞避让。
- 已存在的 `stable_first` 会自动吃到同一套负载信号，不需要新增路由策略枚举。

说明：

- 如果需要“全局负载感知开关”，应走既有运行时设置链路：
  `src/server/routes/api/settings.ts` + `src/web/pages/Settings.tsx`。
- 但这不是接入负载乘子的前置条件，可以在后续单独补。

### Phase 3：恢复探测成功路径 + 后台恢复任务

依赖：

- 依赖 Phase 0 的共享 prompt
- 依赖 Phase 1 的四态 probe
- 依赖 Phase 2 的负载 / 运行态读取能力

范围：

- 修改 `src/server/services/tokenRouter.ts`
- 新增 `src/server/services/channelRecoveryProbeService.ts`
- 修改 `src/server/config.ts`
- 修改 `src/server/index.ts`

实现重点：

1. 在 `tokenRouter.ts` 新增 `recordProbeSuccess(channelId, modelName?)`
   - 清除 `cooldownUntil`
   - 清除 `lastFailAt`
   - 重置 `consecutiveFailCount`
   - 重置 `cooldownLevel`
   - 更新缓存
   - 恢复站点运行时健康
   - **不要**增加 `successCount` / `totalLatencyMs` / `totalCost`

2. 新增 `channelRecoveryProbeService.ts`
   - 扫描仍在冷却中的可用通道
   - 复用 `src/shared/probePrompts.ts`
   - 复用站点代理解析链路：
     `resolveChannelProxyUrl()` + `getDispatcherForProxyUrl()`
   - 命中 `supported` 时调用 `recordProbeSuccess(...)`
   - 其余状态只记录结果，不直接污染业务成功统计

3. 调参按公益站保守值落地
   - 扫描间隔：60s
   - 每轮最多探测：2
   - 并发：1
   - 同通道最短再探间隔：5min
   - 每站点每小时上限：4

4. 在 `src/server/index.ts` 注册启动和关闭
   - 服务启动时开启
   - `app.addHook('onClose', ...)` 中停止

验证建议：

- 新增 `src/server/services/channelRecoveryProbeService.test.ts`
- 补一条针对 `recordProbeSuccess()` 的 `tokenRouter` 单测

### Phase 4：升级现有 stable_first 为“主池 / 观察池”

这一步应视为可选增强，不应和 Phase 2/3 混成一个大补丁。

原因：

- 当前仓库已经在使用 `stable_first`
- 现有 `stable_first` 是“按综合评分选最优候选”
- “主池 / 观察池 + 抽样观察”属于行为升级，风险高于前面三步

范围：

- 修改 `src/server/services/tokenRouter.ts`
- 扩展 `src/server/services/tokenRouter.selection.test.ts`

建议做法：

- 保留现有 `stable_first` 策略名，不新增第四个策略值。
- 先沿用当前 `calculateWeightedSelection()` 的候选评分结果做分层：
  - 主池：接近最优分数的候选
  - 观察池：其余候选
- 再叠加观察间隔与站点冷却：
  - 观察间隔：每 24 个请求抽 1 个
  - 观察站点冷却：30min

不建议现在就做的事：

- 不要把策略选择器再搬到 `Settings.tsx`
- 不要把这一批和恢复探测、四态 probe、负载快照揉成一个 PR

### Phase 5：后台批量 Model Availability Scheduler

继续延后。

原因：

- 当前仓库已经有 `ModelProbeModal`
- 经过 Phase 0 + Phase 1 后，手动探活误伤率会先显著下降
- 自动恢复探测优先级高于“全量模型批量可用性轮询”

---

## 4. 推荐并行拆分

如果要按多轮并行推进，建议这样拆：

第一轮可并行：

- Phase 0：共享 prompt 基线
- Phase 2：Coordinator 负载快照 + 负载乘子

第二轮可并行：

- Phase 1：四态 probe 端到端改造
- Phase 2 的测试补齐和参数校准

第三轮串行：

- Phase 3：恢复探测成功路径 + 后台恢复任务

第四轮串行或小范围灰度：

- Phase 4：stable_first 主池 / 观察池升级

---

## 5. 验证顺序

建议按阶段分别验证，不要最后一次性跑大杂烩。

Phase 1：

```bash
pnpm exec vitest run src/server/services/modelProbeService.test.ts
pnpm exec vitest run src/server/routes/api/accountTokens.probe-models.test.ts
```

Phase 2：

```bash
pnpm exec vitest run src/server/services/proxyChannelCoordinator.test.ts
pnpm exec vitest run src/server/services/tokenRouter.selection.test.ts
```

Phase 3：

```bash
pnpm exec vitest run src/server/services/channelRecoveryProbeService.test.ts
pnpm exec vitest run src/server/services/tokenRouter.test.ts
```

收尾：

```bash
npm run repo:drift-check
```

---

## 6. 一句话结论

基于当前仓库现状，真正应该做的不是“重新引入 stable_first”，而是：

先统一 prompt 与四态 probe，再把负载乘子接进现有选路器，之后单独补
“恢复探测闭环”，最后才考虑把已经上线的 `stable_first` 升级成
“主池 / 观察池”。
