# 上游同步记录

> 记录每次从上游 `cita-777/metapi` 同步的变更。

## 2026-04-04 同步

**上游已审阅到**：`63f6b07`（upstream/main HEAD）

### 已合入的 Commit

| Commit | 说明 | 合入方式 | 备注 |
|--------|------|---------|------|
| `6ad9ec6` | strip codex responses max_output_tokens (#399) | 手工移植 | 2026-04-04 合入，本地提交 `12d357f` |
| `596d1b9` | #330 Codex continuation 模块补齐 | 手工移植 | 2026-04-04 合入，补齐之前 #330 手工移植时跳过的 continuation 部分 |
| `af5b62f` | fix codex responses continuation across channel drift (#404) | 手工移植 | 2026-04-04 合入，在 #330 continuation 基础上应用 |

<details>
<summary>#399 合并详情（2026-04-04）</summary>

**功能说明**：将 Codex responses 兼容性逻辑从 `upstreamEndpoint.ts` 提取到独立模块，并修复 token 限制字段导致的请求失败问题。

**核心改动**：
- 新增 `src/server/transformers/openai/responses/codexCompatibility.ts` (90行)
- 新增 `src/server/transformers/openai/responses/codexCompatibility.test.ts` (46行)
- 修改 `src/server/routes/proxy/upstreamEndpoint.ts`：删除 54 行内联函数，添加 import，简化两处调用
- 更新 `upstreamEndpoint.test.ts`、`chat.codex-oauth.test.ts` 测试断言
- 新增 `architecture-boundaries.test.ts` 边界测试

**关键修复**：
- 删除 Codex responses API 不支持的 3 个字段：`max_output_tokens`、`max_completion_tokens`、`max_tokens`
- 在 `applyConfiguredPayloadRules()` 前后都调用清洗函数，防止配置规则再次注入不支持的字段
- 保留其他 Codex 字段：`previous_response_id`、`prompt_cache_key`、`include`

**Bug 严重性**：高（针对 Codex 用户）
- OpenAI/Claude 风格请求转 Codex 时，`conversion.ts` 会自动补充 `max_output_tokens: 4096`
- 本地旧代码不会删除这些字段，导致所有转 Codex 的请求都会失败
- 不需要用户显式配置，默认就会触发

**合入方式**：手工移植（不是 cherry-pick）
- 原因：本地 `upstreamEndpoint.ts` 已分叉 1299 行（上游 1060 行）
- 策略：按 Codex 分析文档的 5 步骤执行
- 工作量：约 3 小时（分析 + 编码 + 测试）

**验证结果**：
- ✅ `codexCompatibility.test.ts` - 2 passed
- ✅ `upstreamEndpoint.test.ts` - 58 passed
- ✅ `chat.codex-oauth.test.ts` - 6 passed
- ✅ `responses.codex-oauth.test.ts` - 21 passed
- ✅ `architecture-boundaries.test.ts` - 14 passed
- ✅ `repo:drift-check` - Violations: 0

</details>

<details>
<summary>#330 Codex continuation 模块补齐 + #404 合入详情（2026-04-04）</summary>

**背景**：#330（proactive channel probes + load-aware routing）于 2026-04-02 手工移植时，跳过了 Codex responses continuation 相关模块。本次补齐这些模块，并在此基础上应用 #404（修复 Codex responses continuation 在 channel/account 漂移后断裂的问题）。

**功能说明**：
- Codex responses 多轮对话续接：自动记忆 terminal `response.id`，对 tool-output follow-up 自动注入 `previous_response_id`
- 跨通道续接保持：channel/account 漂移后通过 bare-session fallback 仍能找到旧 `responseId`
- `previous_response_not_found` 自动恢复：检测到旧续接 ID 失效时 strip 并重试一次
- Claude continuation-aware routing：检测 Claude 请求中的 continuation hint，优先走 responses endpoint

**新增文件（5 个）**：
- `src/server/proxy-core/runtime/codexSessionResponseStore.ts` (128行) — 通道级 session→responseId 存储
- `src/server/proxy-core/runtime/codexSessionResponseStore.test.ts` — 5 用例
- `src/server/transformers/openai/responses/continuation.ts` (144行) — continuation 辅助函数
- `src/server/transformers/openai/responses/continuation.test.ts` — 4 用例
- `src/server/transformers/anthropic/messages/compatibility.test.ts` — 4 用例

**修改文件（11 个）**：
- `codexWebsocketRuntime.ts` — +82行：continuation 注入/记忆/recovery/清理
- `openAiResponsesSurface.ts` — +92行：8 处集成点（scoped key、inject、remember×4、tryRecover、queue key）
- `responsesWebsocket.ts` — +50行：scoped session key + 多 key 清理 + HTTP event 包装
- `upstreamEndpoint.ts` — +32行：`stripClaudeMessagesContinuationFields` + `wantsContinuationAwareResponses`
- `chatSurface.ts` — +8行：Claude continuation-aware routing（仅主 chat 路径）
- `compatibility.ts` — +52行：`shouldPreferResponsesForAnthropicContinuation()`
- 测试文件：`codexWebsocketRuntime.test.ts`(+187)、`responses.codex-oauth.test.ts`(+260)、`responses.websocket.test.ts`(+259)、`upstreamEndpoint.test.ts`(+131)、`chat.count-tokens.test.ts`(+43)

**合入方式**：手工移植
- 原因：`codexWebsocketRuntime.ts`、`openAiResponsesSurface.ts`、`chatSurface.ts` 等文件已独立演进，与上游有较大分叉
- 策略：从上游 #330 (`596d1b9`) 提取 continuation 子集 + #404 (`af5b62f`) 叠加，由 Codex gpt-5.4 xhigh 审查 plan → 实施 → Antigravity 复核

**验证结果**：
- ✅ `codexSessionResponseStore.test.ts` - 5 passed
- ✅ `continuation.test.ts` - 4 passed
- ✅ `compatibility.test.ts` - 4 passed
- ✅ `codexWebsocketRuntime.test.ts` - 9 passed
- ✅ `upstreamEndpoint.test.ts` - 63 passed
- ✅ `responses.codex-oauth.test.ts` - 24 passed
- ✅ `responses.websocket.test.ts` - 27 passed
- ✅ `chat.count-tokens.test.ts` - 2 passed
- ✅ TypeScript 检查 - 无新增错误
- **总计 138 测试全部通过**

</details>

---

## 2026-04-03 同步

**上游已审阅到**：`63f6b07`（upstream/main HEAD）

### 已合入的 Commit

| Commit | 说明 | 合入方式 | 备注 |
|--------|------|---------|------|
| `b9b553d` | fix: sqlite migration journal recovery (#400) | `git cherry-pick` | 2026-04-03 合入，本地提交 `2d0ba35` |
| `63f6b07` | cap sqlite migration recovery retries (#410) | `git cherry-pick` | 2026-04-03 合入，本地提交 `28e1b11` |

### 验证备注

- `npm test -- src/server/db/migrate.test.ts`：合入前后都只有同一条既有红测，`replays missing migrations before marking a duplicate-column migration as applied` 仍因测试夹具缺少 `downstream_api_keys` 基表而失败，不是 #400/#410 回归。
- 合入后 `migrate.test.ts` 变为 `11 tests | 1 failed`，新增的 #400/#410 用例已通过。
- `npm run typecheck` 当前仍失败于 `src/web/pages/helpers/sitesEditor.test.ts` 缺少 `probeDisabled`，属于本次 SQLite migration 合并之外的既有问题。

### 跳过的 Commit（已审阅，不需要）

| Commit | 说明 | 跳过原因 |
|--------|------|----------|
| `bc3893f` | refine token routes workspace motion and hierarchy (#394) | 14 文件 +2470/-733 行，本地 TokenRoutes UI 已独立演进（+8261 行差异），合入会破坏探活/健康度/优先级编辑等现有功能 |
| `19bfed2` | refresh integration and settings docs for current UI and provider coverage (#398) | 12 文件 +982/-238 行，纯文档更新，本地已有完善的自定义文档体系（docs/custom/），冲突大价值低 |
| `082891a` | fix runtime settings restart hydration (#392) | 8 文件 +365/-279 行，纯重构（提取 runtimeSettingsHydration.ts），冲突极高（需重构 5+ 文件），价值不足以抵消成本 |
| `2be0603` | fix expired connection health recovery (#393) | 10 文件 +406/-17 行，**不适合当前部署场景**（详见下方分析） |

<details>
<summary>#393 深度分析（2026-04-04）</summary>

**功能说明**：当账号状态为 `expired` 时，用户编辑并替换新的 API Key，系统自动尝试刷新模型，成功则自动激活账号。

**核心改动**：
- 新增 `accountUpdateWorkflow.ts`（65行）：封装账号更新工作流
- 修改 `accounts.ts` PUT 路由：智能检测"替换 key"vs"只改状态"
- 修改 `accountHealthService.ts`：允许对 expired 账号刷新模型
- 216 行测试用例

**不合入原因（当前部署场景分析）**：

本地部署为**单租户/小团队模式**，所有 API Key 由管理员集中管理，主要后端为 new-api（余额制），导致 `expired` 状态的所有场景都不适合通过"替换 key"恢复：

1. **余额不足** → 需在 new-api 后台充值，换 key 无意义
2. **账号被封** → 整个账号不可用，换 key 无意义
3. **手动删除** → 既然删了就不想用，无需恢复
4. **公益站免费 key** → 过期后用户无法自己生成新 key

**可能适用的场景（Codex 分析）**：
- 定期密钥轮换（安全合规要求）
- 多提供商支持（某些提供商的 key 有时间限制）
- 多租户部署（用户自己管理 key）
- 安全事件后重新生成 key
- 开发/测试环境（测试 key 定期过期）

**结论**：当前部署不涉及上述场景，维护成本 > 收益，建议跳过。如未来扩展为多租户或增加其他 API 提供商，可重新评估。

</details>

### 待定的 Commit（需进一步评估）

| Commit | 说明 | 待定原因 |
|--------|------|----------|
| `af5b62f` | fix codex responses continuation across channel drift (#404) | 3 文件 +288/-6 行，修复 Codex responses 多轮对话续接问题，但缺失前置依赖 `codexSessionResponseStore.ts`（在上游 #330 中引入，本地手工移植时未包含） |

---

## 2026-04-02 同步

**上游已审阅到**：`1407f75`（upstream/main HEAD）

### Cherry-pick 的 Commit

| Commit | 说明 | 冲突 |
|--------|------|------|
| `e8921e6` | fix: orphaned responses tool outputs in messages fallback (#342) | ✅ 无冲突 |
| `4ca88d0` | fix: responses-to-chat tool stream fidelity (#378) | ✅ 无冲突（auto-merge chatFormatsCore.ts） |
| `e2d9481` | fix: anyrouter balance refresh challenge errors (#368) | ✅ 无冲突 |
| `8675ff3` | fix: cap weighted route backoff overflow crash (手动移植 #354) | ⚠️ tokenRouter.ts 已分叉，手动移植 3 行（Math.min cap） |
| `5fffcb6` | feat: support CIDR admin allowlists (#377) | ✅ 无冲突 |
| `8739065` | fix: add searchable token account selectors (#347) | ✅ 无冲突 |
| `6b19d06` | fix: empty stream success handling and unknown usage logs (#343) | ⚠️ chatSurface.ts/openAiResponsesSurface.ts/ProxyLogs.test.tsx 3处冲突，保留本地协议亲和性逻辑 + 采用上游空流成功处理 |
| `ace5ddd` | fix: edit payload clearing boundaries (#381) | ⚠️ 5处冲突：accountsRoutePayloads.ts/monitor.test.ts（modify/delete，接受上游重建）+ tokens.ts/downstreamApiKeys.ts/test 内容冲突 |
| `1e0dffe` | fix: mysql insert boundary handling (#364) | ⚠️ 7处冲突：accountTokens.ts/sites.ts/tokens.ts/downstreamApiKeys.ts 内容冲突 + oauthSiteRegistry.ts/proxyDebugTraceStore.ts（modify/delete，接受上游）|

### 手工移植的 PR（非 cherry-pick，按能力拆相位逐步实现）

| 上游 Commit | PR | 移植范围 | 改动 | 说明 |
|-------------|-----|---------|------|------|
| `596d1b9` | #330 | Phase 0-5 | 11 文件改动 + 4 新增 | 不能 cherry-pick（53 文件已分叉）。含四态探测、负载感知、stable_first 主池/观察池、自动恢复探测、后台 scheduler。公益站定制：随机真实 prompt（防 AI 封 IP）、per-site 限4h/h、负载系数 0.10/0.12/0.04、recordProbeSuccess 不污染业务统计 |
| `532be86` | #365 | Phase A-C | 12 文件改动 (+470) | 不能 cherry-pick（路由/服务层已分叉）。含可配置 failureCooldownMaxSec（env + settings 持久化 + 读写路径统一 clamp）、route 级批量清冷却 API（visible source routes + runtime health 联动）、前端清除冷却按钮（best-effort 刷新）。本地定制：round-robin 阶梯冷却不受 cap 限制、不清 failCount 保留历史统计 |
| `180d17a` | #383 | Phase 1-4 | 30+ 文件改动 | 不能 cherry-pick（43 文件已分叉）。已完成分阶段手工移植：首字节超时核心模块（fetchWithObservedFirstByte + AbortSignal 透传 + replay stream）、endpointFlow 集成（per-attempt 计时、超时视为 retryable）、chatSurface/openAiResponsesSurface/geminiSurface 三个 surface 接入、direct routes（completions/embeddings/images/search）接入、config + settings runtime 读写链、proxy_logs `is_stream/first_byte_latency_ms` schema/store/stats API、ProxyLogs badges、Settings 前端输入框。本地定制：默认值保持 `0`，按当前 fork owner 拆相位实施，不引入上游 site endpoint pool 架构 |

### 跳过的 Commit（已审阅，不需要）

| Commit | 说明 | 跳过原因 |
|--------|------|----------|
| `6e04db6` | fix: site-created dialog cancel cleanup (#341) | SiteCreatedModal 本地已重构为 CenteredModal，补丁无法 apply |

| `3ce5179` | fix: detect latest digest updates in update center (#344) | Update center 基础设施 |
| `d930b87` | fix: Anyrouter model sync shield handling (#348) | Anyrouter 专用修复 |
| `baa11d7` | cache update center status snapshots (#349) | Update center 基础设施 |
| `e74e113` | add route priority bucket editor (#350) | 路由优先级桶编辑器，改动较大 |
| `0de9c5e` | add coding plan site initialization flow (#351) | Codex/CodingPlan 初始化流程 |
| `bafceb8` | add model tester fixed-channel selection (#352) | 27 文件 +1331 行，tester 特殊逻辑渗入生产路径，可后续单独引入 |
| `4096c75` | fix anyrouter checkin session failure classification (#353) | Anyrouter 专用 |
| `6206c5b` | preserve both site-created next steps (#357) | 依赖 #351 |
| `8c3be1a` | add zod payload contracts for admin API (#358) | 适合分模块渐进引入，不适合一次吞 |
| `3ebe851` | fix update helper health for ready failed release (#361) | Update center |
| `aac1307` | add vendor code entry presets follow-up (#363) | 依赖 #351 |

| `532be86` | add route cooldown controls (#365) | ✅ **已手工移植**（见上方"手工移植"章节） |
| `21d92e1` | recognize structured oauth accounts in routing (#369) | OAuth 功能 |
| `37a86d1` | background route decision refresh (#370) | 路由决策后台刷新 |
| `6e21f91` | add route priority left rail (#371) | 路由优先级 UI 系列 |
| `76c85d0` | split site API endpoint pool (#373) | 体量巨大(+7220)，上游架构演进方向，暂不合入 |
| `ce77bde` | align route priority drag preview (#375) | 路由优先级 UI 系列 |
| `1133846` | restore route priority drag behavior (#376) | 路由优先级 UI 系列 |
| `596d1b9` | proactive channel probes + load-aware routing (#330) | ✅ **已手工移植**（见上方“手工移植”章节） |
| `bcd758e` | harden background task completion waits (#382) | 测试改进，依赖 #330 |
| `180d17a` | add proxy first-byte timeout and log badges (#383) | ✅ **已完成分阶段手工移植**（见上方"手工移植"章节） |
| `52c6ff5` | route codex websocket through site api endpoints (#386) | 依赖 #373 |
| `ed2783e` | fix route detail dropdown clipping (#388) | UI 小修 |
| `1407f75` | add Fedora desktop rpm packaging (#390) | RPM 打包 |

### 值得后续关注的大型 PR（已深度分析）

- **#330** (主动探活+负载感知路由) — ✅ 已完成手工移植，含四态探测、负载感知、stable_first 主池/观察池、自动恢复探测
- **#365** (路由冷却控制) — ✅ 已完成手工移植，含可配置冷却上限、route 级批量清冷却、前端按钮
- **#383** (首字节超时) — ✅ 已完成分阶段手工移植，含 direct routes / proxy_logs / UI
- **#373** (Site API Endpoint Pool) — ⏸️ 暂不合入，当前需求不迫切。详见下方深度分析

<details>
<summary>#373 深度分析（2026-04-03）</summary>

**核心架构**：把 site 拆成管理面板地址 + AI 请求地址池（`siteApiEndpoints` 表），支持同一站点多个 API 入口自动轮转 + endpoint 级 cooldown/故障隔离。

**核心组件**：
- `siteApiEndpoints` 新表：per-site 多 endpoint，各自 cooldown/lastFail/sortOrder
- `siteApiEndpointService.ts` (287行)：选择 + 故障分类(retryable vs non-retryable) + cooldown 5min + 自动轮转
- `runWithSiteApiEndpointPool(site, fn)`：所有代理路由/模型发现的统一入口，失败自动轮转

**改动范围**：49 文件 +7220/-980 行，涉及所有代理路由（completions/embeddings/images/search/videos）、两个 surface（chatSurface/openAiResponsesSurface）、模型发现、备份/迁移、Sites UI。

**不合入原因**：
1. 当前站点数量有限，多入口需求不强烈
2. 16 个核心文件与本地分叉严重（chatSurface 31处差异、accounts 25处差异），手工移植工作量大
3. 后续直接依赖仅 #386（codex websocket 走 endpoint pool），其余 PR 不受影响

**值得借鉴的思路**（供未来参考）：
- 站点管理地址与请求地址解耦
- endpoint 级故障分类：retryable(408/429/5xx) 自动轮转+cooldown，non-retryable(400/401/403) 直接抛错
- `runWithSiteApiEndpointPool` 统一包装模式

**如果未来要做，分相位路径**：
1. Phase 0: 新建表 + service（纯增量，零冲突）
2. Phase 1: platformDiscoveryRegistry 接入
3. Phase 2: direct routes 接入（机械替换）
4. Phase 3: surfaces 接入（差异最大）
5. Phase 4: Sites UI editor（可选）

</details>

---

## 2026-03-31 同步

**上游已审阅到**：`618ca0b`（upstream/main HEAD）

### Cherry-pick 的 Commit

| Commit | 说明 | 冲突 |
|--------|------|------|
| `eb65a2b` | fix: preserve repeated short responses deltas (#336) | ✅ 无冲突 |
| `9e95819` | fix: decode zstd-compressed SSE proxy surfaces (#335) | ⚠️ `geminiSurface.ts` 1处冲突（SSE reader 获取方式），保留本地 reply.hijack() + 采用上游 getRuntimeResponseReader() |
| `9212b76` | feat: 新站点创建后显示选择对话框 (#302) | ⚠️ `Sites.tsx` 1处冲突（与本地 bulkImport 位置重叠），两者均保留 |

### 跳过的 Commit（已审阅，不需要）

| Commit | 说明 | 跳过原因 |
|--------|------|----------|
| `618ca0b` | fix: restore armv7 docker base image (#337) | Docker ARM 构建修复，不影响功能 |
| `5d54e92` | docs: add management API guide (#334) | 纯文档 |
| `9eb33df` | [codex] add automatic update-center reminders (#333) | K3s update-center 基础设施，不需要 |
| `6726da9` | persist proxy trace panel state (#331) | 依赖代理调试追踪（#299，已跳过） |
| `9aeec87` | chore: sweep dependabot updates and align Node 25 (#329) | 依赖升级，可能引入不兼容 |
| `26f9717` | [codex] add setting to disable cross-protocol fallback (#332) | 全局级开关，个人使用场景不需要；站点级实现成本高 |
| `fa25a50` | feat: 实现全局模型白名单功能 (#301) | 已有3层模型过滤，全局白名单增加 debug 难度 |
| `01481be` | [codex] Add digest-safe k3s update-center assets (#326) | K3s 基础设施 |
| `7d91823` | Add site filters for manual connection selection (#328) | 已有类似站点排除功能 |
| `0d2c450` | make proxy trace panel collapsible (#327) | 依赖 #299 |
| `26d87db` | [codex] tighten update center and proxy debug UX (#325) | 依赖 #299 + update-center |
| `71be4cb` | Handle codex OAuth usage-limit cooldowns (#316) | OAuth 功能，per-credential cooldown 思路可借鉴 |
| `d47c3c4` | Support digest-aware update center rollbacks (#318) | K3s 基础设施 |
| `b9ae85e` | Fix update center helper token lookup (#317) | K3s 基础设施 |
| `faf9874` | Fix armv7 docker helper build | Docker 构建修复 |
| `11583c5` | [codex] add K3s update center (#314) | K3s 基础设施 |
| `dcfd45e` | Fix proxy debug trace truncation previews (#313) | 依赖 #299 |
| `7092e2f` | [codex] refine proxy logs debug UI follow-ups (#312) | 依赖 #299 |
| `ab8640c` | [daily] reset oauth proxy form after start (#311) | OAuth 功能 |
| `ed44e7f` | Refine proxy logs debug trace UI (#309) | 依赖 #299 |

---

## 2026-03-27 同步

**分叉点**：`7e1fb8e`

### Cherry-pick 的 Commit

| Commit | 说明 | 冲突 |
|--------|------|------|
| `8ebfc39` | [codex] add harness engineering guardrails (#284) | ✅ 无冲突 |
| `40b8edd` | chore: remove committed local debug artifacts | ✅ 无冲突 |
| `b3387df` | [codex] fix cross-database JSON boundary handling (#283) | ⚠️ `databaseMigrationService.ts` import 冲突，已解决 |

### #284 — 工程守护规范

新增文件：
- `AGENTS.md` — Codex agent 工程约束
- `docs/engineering/harness-engineering.md` — 守护工程文档
- `scripts/dev/repo-drift-check.ts` — 仓库规范检查脚本
- `.github/workflows/harness-drift-report.yml` — CI drift 报告

代码改动：
- `proxy-core/executors/types.ts` — `readRuntimeResponseText` 增加防御性检查
- `proxy-core/surfaces/*.ts` — 统一使用 `readRuntimeResponseText`

### #283 — JSON 边界修复

修复 PostgreSQL 与 SQLite 之间的 JSON 列类型差异。PostgreSQL 的 JSON 列返回 JS 对象而非字符串，导致 `JSON.parse()` 失败。

核心改动：所有 JSON 解析函数的签名从 `string | null` 扩展为 `string | Record<string, unknown> | null`。

涉及文件：`accountExtraConfig.ts`、`accountHealthService.ts`、`tokenRouter.ts`、`databaseMigrationService.ts` 等 30 个文件。

### 清理调试文件

删除误提交的调试脚本和数据文件（`query_site.ts`、`test_api.ts`、`tokens_result.json` 等）。

---

## 2026-03-29 同步

**上游已审阅到**：`03ca115`（origin/main HEAD）

### Cherry-pick 的 Commit

| Commit | 说明 | 冲突 |
|--------|------|------|
| `3bf3cd1` | feat: 新增路由批量禁用/启用功能 (#295) | ⚠️ `tokens.ts` 3处冲突，保留本地增强（tokenId归一化、priority/weight范围校验） |

### 跳过的 Commit（已审阅，不需要）

| Commit | 说明 | 跳过原因 |
|--------|------|----------|
| `5ae452a` | [codex] inherit site proxy settings for oauth (#296) | 不需要 OAuth 代理功能 |
| `4d4684a` | [codex] add proxy debug tracing (#299) | 不需要代理调试追踪，且体量大(+6669行)、migration序号冲突 |
| `785ee93` | fix gemini oauth validation site proxy (#298) | 依赖 #296，不需要 |
| `03ca115` | Add OAuth account proxy controls (#307) | 不需要 OAuth 代理功能 |

### 已在之前同步过的（重复）

| 上游 Commit | 本地等价 Commit | 说明 |
|-------------|----------------|------|
| `b3387df` | `8959f1a` | #283 JSON 边界修复 |
| `8ebfc39` | `130be0e` | #284 harness 工程护栏 |
| `40b8edd` | `4990479` | 清理调试文件 |

---

## 本地独有 Commit

以下为自定义功能 commit，不在上游中：

| Commit | 说明 |
|--------|------|
| `88681e9` | feat: 实现令牌级模型管理与站点模型探测功能 |
| `053c9fb` | 探活功能增强：可点击查看详情、批次间隔、反风控优化 |
| `8640cfc` | fix: allowed-models 接口使用事务保证原子性 |
| `279adcd` | fix: useCallback 依赖数组补充 delayMs，修复批次间隔不生效 |
| `da23f65` | fix: 站点添加/编辑表单恢复单列垂直布局 |
| `347da78` | fix: 修复下拉菜单被父容器裁剪不可见问题 & 优化探活默认配置 |
| `89fbe5c` | feat: 隐藏我不需要的UI |
| `3314dab` | fix: backupService 补充 accountTokens 缺失字段 |
| `4e608b5` | fix: 启动时自动迁移 account_tokens 自定义列 |
| `6d42355` | docs: 新增自定义修改文档 (schema变更/功能说明/部署指南/同步记录) |
| `365c13e` | feat: 站点探测禁用 + API Key 连接模型过滤 |
| `025cf91` | fix: 通道 tokenId 校验优化 + 登录会话延长至30天 + 剥离上游IP泄漏请求头 |
| `2156154` | feat: 通道优先级与权重手动配置 — 路由 UI 新增 Priority/Weight 编辑 + 后端校验统一 |
| `2cb16c0` | fix: 修复 Codex 审查发现的 7 项问题 |
| *(merged)* | refactor: 精简模型发现 — Session 连接跳过账号级发现 + probeDisabled 手动刷新放行 |
| *(merged)* | feat: API Key 连接新增探活功能 + 探活模型选择改为多选框 |
| *(merged)* | feat(路由健康): 站点运行时惩罚重置 + WebUI 健康 badge/操作按钮 |
| `2bd80d1` | feat(路由健康): 通道级冷却重置 + 站点惩罚 DB 同步 + WebUI 操作按钮 |
| `884855a` | feat(探活): 路由级批量探活 + 单通道探活 + 按性能应急排序 — channelProbeService / SSE 流式批量探活 / 三段式排序写回 / 前端会话管理 + UI |
| `40b9894` | feat(探活): 路由探活结果持久化 + 权重优先级混合排序 — localStorage 快照 + 拓扑失效检测 + 权重分档(200/100/30) + CenteredModal 确认 + 三态渲染 |

---

## 2026-04-05 跟进

**上游主线状态**：`63f6b07`（`upstream/main` 未前进）

### 新发现的分支提交（未进入 upstream/main）

| Commit | 分支 | 说明 | 处理结果 |
|--------|------|------|----------|
| `060f28b` | `upstream/codex/daily-codex-session-roundtrip` | keep codex continuation current across scope roundtrips | 已审阅并按本地语义手工补齐到当前工作区 |

### `060f28b` 跟进说明

**背景**：本地已在 2026-04-04 合入 Codex continuation 与跨 channel/account drift 续接能力，但 `codexSessionResponseStore` 只覆盖了“单向漂移”语义，未处理同一 downstream session 发生 `A -> B -> A` 的 scope roundtrip。

**上游修复点**：
- 在 `codexSessionResponseStore.ts` 新增 `reconcileScopedSessionFallback()`
- 当 `getCodexSessionResponseId()` 命中 bare-session fallback 时，清理同 bare session 下的旧 scoped key
- 避免回到旧 scope 时继续命中过期的 `previous_response_id`

**本地手工补齐内容**：
- `src/server/proxy-core/runtime/codexSessionResponseStore.ts`
  - fallback 命中时追加旧 scoped key 清理逻辑
- `src/server/proxy-core/runtime/codexSessionResponseStore.test.ts`
  - 新增 roundtrip 回归用例：同一 downstream session 从原 scope 漂到新 scope，再漂回原 scope 时，应始终返回最新 continuation id

**验证结果**：
- ✅ `npx vitest run src/server/proxy-core/runtime/codexSessionResponseStore.test.ts` - 6 passed
- ✅ `npx vitest run src/server/routes/proxy/responses.codex-oauth.test.ts` - 24 passed

**结论**：
- 该提交不是上游主线前进，而是 `#330/#404` 之后的一个小型 continuation follow-up
- 改动面很小，但能补齐当前本地 continuation store 在 scope roundtrip 场景下的一致性缺口

---

## 2026-04-06 审阅（v1.3.0）

**上游已审阅到**：`63c435c`（`v1.3.0` tag）

**Release 信息**：
- `v1.3.0` 发布时间：`2026-04-06T07:55:55Z`
- 相对上次审阅基线 `63f6b07`，上游主线新增 `26` 个 commit

### 已有本地等价覆盖 / 状态修正

| Commit | 说明 | 处理结果 | 备注 |
|--------|------|----------|------|
| `b3e987a` | keep codex continuation current across scope roundtrips (#416) | 无需重复合入 | 本地已在 `2026-04-05` 先按分支提交 `060f28b` 手工补齐，并落地为本地提交 `dc86d9f`；本次只需确认该修复已进入 upstream/main |
| `193f3e7` | fix proxy log usage source metadata (#428) | 无需重复合入 | 本地当前已把 `usageSource` 透传到 proxy log message，收益已基本等价覆盖 |

### 建议优先合入

| Commit | 说明 | 建议 | 原因 |
|--------|------|------|------|
| `5b005d8` | fix: tighten generic upstream passthrough headers (#422) | 手工移植（repo-local 最小修正） | 当前 `upstreamEndpoint.ts` 的 generic passthrough 仍按“仅过滤 hop-by-hop / blocked headers”直透，范围偏宽；适合按本地 owner 收紧 allowlist，并保留 Codex 所需 `Version` 与 `x-responsesapi-include-timing-metrics` |
| `3e8d69b` | fix codex compact non-stream accept header (#439) | 手工移植 | 本地已支持 `/v1/responses/compact` 且显式禁止 stream，但 `headerUtils.ts` 中 Codex runtime header 仍固定 `Accept: text/event-stream`；这是一个直接的 repo-local 缺口 |

### 第二批候选（按真实使用量 / 线上痛点再跟）

| Commit | 说明 | 建议 | 原因 |
|--------|------|------|------|
| `df75a80` | Fix responses compact fallback handling (#426) | 条件性手工移植 | 若当前确实有 `responses/compact` 使用量，值得继续补上 compact 失败回退到普通 responses 的兜底与 sanitize；否则优先级次于 `#439` |
| `6feda0e` | fix downstream client detection boundaries (#429) | 只摘边界 heuristics / 测试 | 本地已有自己的 downstream client detection owner；上游价值主要在边界修复，适合小范围吸收，不适合整块重排 |
| `a789ddf` | add sub2api managed refresh resilience (#441) | 有明确痛点再单开 | 本地已有 sub2api managed refresh 能力，但上游这条是 scheduler / singleflight / 启动调度级增强，不是简单小修 |
| `42f9049` | align antigravity special-model non-stream path with CPA (#444) | 有真实流量问题再跟 | 本地已有 antigravity runtime executor；只有在 special-model 非流式路径出现真实问题时，才值得专门吸收 |

### 建议继续跳过

| Commit | 说明 | 跳过原因 |
|--------|------|----------|
| `afbbc4c` | fix failed expired api-key recovery route preservation (#421) | 仍属于 `#393 expired connection health recovery` follow-up；当前部署场景与 owner 边界未变，继续不适合 |
| `3edeb6e` | refine OAuth proxy controls and quota UI (#433) | 属于 OAuth proxy / quota 管理线扩展，本地当前优先级低 |
| `2f0e63a` | add oauth route pools and proxy save flow (#440) | 引入 `drizzle/0021_young_shriek.sql` 与 OAuth route pool 新体系，超出当前 fork “repo-local 最小修正”边界 |
| `2b9200e` | fix proxy debug undici response header capture (#442) | 依赖此前已跳过的 proxy debug tracing 体系（`#299` 线） |
| `d1b42b2` | support oauth route unit inserts on postgres (#443) | 依赖 `#440` 的 OAuth route unit 线 |
| `448f488` | improve oauth route unit feedback (#445) | 依赖 `#440/#443` 的 OAuth route unit 线 |
| `ff43fce` / `9045a48` / `ef1962d` / `d5560fb` / `b3f6fa0` / `c10b1e7` | `#419/#420/#423/#424/#425/#427` | UI / 桌面 / 文案调整为主，本地对应 area 已明显分叉，当前收益不高 |
| `492f43c` / `38721cb` / `287c5aa` | `#430/#431/#432` | OAuth / downstream key 管理面增强，本轮不作为合入候选 |
| `566501b` / `f18aa98` / `63c435c` | 发版流水线提交 | 版本号、桌面打包修复、release tests 调整，不需要同步到当前 fork |

<details>
<summary>v1.3.0 本轮筛选说明（2026-04-06）</summary>

**本轮结论**：
- 第一批建议合入：`#422`、`#439`
- 第二批按使用量或痛点决定：`#426`、`#429`、`#441`、`#444`
- `#416`、`#428` 已有本地等价覆盖，不需要重复实现
- OAuth route pool / proxy / quota / unit 这条线（`#433/#440/#443/#445`）继续跳过

**repo-local 锚点**：
- `src/server/routes/proxy/upstreamEndpoint.ts`
  - 当前 `extractSafePassthroughHeaders()` 仍是宽透传策略，因此 `#422` 有现实收益
- `src/server/proxy-core/providers/headerUtils.ts`
  - 当前 Codex runtime header 固定 `Accept: text/event-stream`，因此 `#439` 与本地 `/v1/responses/compact` 能力存在直接错位
- `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
  - 本地已支持 `/v1/responses/compact`，并对 compact 请求禁止 stream；后续如要继续跟 `#426/#439`，应以这里的现有语义为准

**落地方式**：
- 不建议直接 cherry-pick `#422/#439`
- 继续沿用当前 fork 的做法：按 owner 手工摘取能力点，保持本地语义与调用链不被上游新体系反向牵动

</details>

---

## 2026-04-06 实施（#422 / #439）

**处理结果**：`#422`、`#439` 已按 repo-local 语义手工移植到当前工作区

### 本次落地的上游 Commit

| Commit | 说明 | 合入方式 | 备注 |
|--------|------|---------|------|
| `5b005d8` | fix: tighten generic upstream passthrough headers (#422) | 手工移植 | 收紧 generic passthrough allowlist，并为 Codex 单独保留 `version` / `x-responsesapi-include-timing-metrics` |
| `3e8d69b` | fix codex compact non-stream accept header (#439) | 手工移植 | `buildCodexRuntimeHeaders()` 改为根据 `stream` 决定 `Accept`，非流式返回 `application/json` |

### 本地实现说明

**代码改动**：
- `src/server/routes/proxy/upstreamEndpoint.ts`
  - generic passthrough 从黑名单式过滤改为 allowlist
  - 新增 Codex 专用 passthrough，仅保留 `version` 与 `x-responsesapi-include-timing-metrics`
  - 额外保留 `x-metapi-responses-websocket-transport` 作为内部 provider hint，只用于本地 Codex header 默认值判定，不作为上游透传头
- `src/server/proxy-core/providers/headerUtils.ts`
  - `buildCodexRuntimeHeaders()` 新增 `stream` 参数
  - `stream === false` 时发送 `Accept: application/json`
- `src/server/proxy-core/providers/codexProviderProfile.ts`
  - 调用 header builder 时显式透传 `input.stream`

**测试改动**：
- `src/server/routes/proxy/upstreamEndpoint.test.ts`
  - 新增 generic allowlist 覆盖用例
  - 新增 Codex 兼容头保留用例
  - 更新 Codex 非流式 `Accept` 断言
- `src/server/proxy-core/providers/headerUtils.test.ts`
  - 覆盖 Codex 非流式 `Accept: application/json`
- `src/server/routes/proxy/responses.compact-upstream.test.ts`
  - 补齐当前 runtime / proxy log 路径需要的测试夹具导出，恢复该 suite 在当前 fork 下的可运行性

### 验证结果

- ✅ `npx vitest run src/server/proxy-core/providers/headerUtils.test.ts` - 7 passed
- ✅ `npx vitest run src/server/routes/proxy/upstreamEndpoint.test.ts` - 65 passed
- ✅ `npx vitest run src/server/routes/proxy/responses.compact-upstream.test.ts` - 4 passed
- ✅ `npx vitest run src/server/routes/proxy/responses.codex-oauth.test.ts` - 24 passed
- ✅ `npm run repo:drift-check` - Violations: 0
- ✅ `npm run typecheck` - passed

### 备注

- 本次没有顺手并入 `#426` compact fallback；仍保持为后续独立候选
- `#422` 的 repo-local 差异点是：内部控制头与上游 passthrough 头继续分层处理，避免 allowlist 收紧后误伤本地 Codex websocket transport 默认行为

---

## 2026-04-06 补充说明（上游可见性）

针对本次 `#422 / #439` 的一个额外确认：

- 当前 fork 里出现的 `x-metapi-*` 头，仅作为 **metapi 内部 hint** 使用
- 其中：
  - `x-metapi-responses-websocket-mode` 只参与本地 responses 分支逻辑，不进入上游 header
  - `x-metapi-responses-websocket-transport` 只在 Codex provider header 默认值判定时参与内部处理，不作为上游透传头发出

**结论**：

- 上游不会直接看到 `x-metapi-*` 命名的 header
- 当前实现的目标是“让上游看起来像目标客户端生态请求”，而不是把 metapi 自身标识暴露给上游
- 这不等于“完全透明原样透传”，但至少满足“不让上游一眼识别为 metapi 请求”的目标

---

## 2026-04-06 实施（#426）

**处理结果**：`#426` 已按 repo-local 语义完成手工移植；本地提交：`f7b6ad9`

### 本次落地的上游 Commit

| Commit | 说明 | 合入方式 | 备注 |
|--------|------|---------|------|
| `df75a80` | Fix responses compact fallback handling (#426) | 手工移植 | 按当前 fork 的 compact 语义拆成 `P0 + P1` 完成，不直接 cherry-pick 上游 patch |

### 本地实现说明

**P0 核心补齐**：
- `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
  - compact 请求固定只走 `responses` 候选，不再继续降级到 `chat / messages`
  - Codex compact 不再被强制拉回上游流式
  - 发往 `/responses/compact` 前剥离 `stream` / `stream_options`
- `src/server/proxy-core/capabilities/responsesCompact.ts`
  - 新增 `sanitizeCompactResponsesRequestBody(...)`
  - 新增 `shouldFallbackCompactResponsesToResponses(...)`
- `src/server/routes/proxy/responses.compact-upstream.test.ts`
  - 补齐 compact 不跨协议降级与 Codex compact 非流式请求覆盖

**P1 运行时开关与 fallback 接线**：
- `src/server/config.ts`
  - 新增 `responsesCompactFallbackToResponsesEnabled`，默认 `false`
- `src/server/index.ts`
  - 在 `applyRuntimeSettings(...)` 中接入 `responses_compact_fallback_to_responses_enabled`
- `src/server/routes/api/settings.ts`
  - 接入 runtime settings 返回、更新与持久化
- `src/web/api.ts`
  - 接入前端 runtime settings payload 类型
- `src/web/pages/Settings.tsx`
  - 新增「Compact 明确不支持时回退到普通 Responses」开关
- `src/web/pages/settings.proxy-transport.test.tsx`
  - 覆盖开关初始值、切换与保存 payload

### repo-local 差异点

- fallback 仍只允许：
  - `/responses/compact -> /responses`
- 不允许：
  - `compact -> chat`
  - `compact -> messages`
- 吸收外部审查意见后，对 `404` fallback matcher 做了额外收紧：
  - 只有带 compact hint 的 `404` 才允许触发 fallback
  - 避免“模型不存在”类 `404` 误判成 compact endpoint 不支持

### 验证结果

- ✅ `npx vitest run src/server/proxy-core/capabilities/responsesCompact.test.ts` - 3 passed
- ✅ `npx vitest run src/server/routes/proxy/responses.compact-upstream.test.ts` - 8 passed
- ✅ `npx vitest run src/server/routes/proxy/responses.compact.test.ts` - 2 passed
- ✅ `npx vitest run src/server/transformers/openai/responses/outbound.test.ts` - 11 passed
- ✅ `npx vitest run src/web/pages/settings.proxy-transport.test.tsx` - 1 passed
- ✅ 合计 targeted tests - 25 passed
- ✅ `npm run repo:drift-check` - Violations: 0

### 结论

- `#426` 现在已从“第二批候选”变为“已完成 repo-local 手工移植”
- 当前 fork 的 `/v1/responses/compact` 已具备：
  - 非流式请求 sanitize
  - compact 专用 fallback matcher
  - 可配置的 `compact -> /responses` 回退开关
  - Settings UI 与持久化开关控制

---

## 2026-04-06 实施（#429）

**处理结果**：`#429` 已按“完全跟随上游 detection 边界”的口径完成 repo-local 手工移植；当前工作区已完成实现，待提交

### 本次落地的上游 Commit

| Commit | 说明 | 合入方式 | 备注 |
|--------|------|---------|------|
| `6feda0e` | fix downstream client detection boundaries (#429) | 手工移植 | 只吸收 detection 边界修复与对应回归测试，不跟随后续 owner 迁移 |

### 本地实现说明

**核心实现**：
- `src/server/proxy-core/cliProfiles/codexProfile.ts`
  - `Codex` detection 不再识别 `/v1/messages`
  - `/v1/responses` 从宽前缀收紧为：
    - 精确 `/v1/responses`
    - `/v1/responses/` 子路径
  - 避免 `/v1/responsesfoo` 这类 sibling 被误判为 `codex`
- `src/server/proxy-core/cliProfiles/claudeCodeProfile.ts`
  - 保持 `metadata.user_id -> sessionId` 为第一优先级
  - 新增 `claude-cli` header fallback：
    - `user-agent=claude-cli/<semver>`
    - `anthropic-beta`
    - `anthropic-version`
    - `x-app=cli`
  - 无 `sessionId` 时只识别 `claude_code` family，不伪造 `sessionId/traceHint`
- `src/server/routes/proxy/downstreamClientContext.ts`
  - 新增 `OpenCode` app fingerprint：
    - `x-title` / `referer` / `http-referer` / `origin` / `user-agent` 命中时记为 exact
  - 新增 `OpenCode` system prompt heuristic：
    - 支持 `system: string`
    - 支持 `system: Array<string | { text: string }>`
  - `OpenCode` 只补 `clientAppId/clientAppName/clientConfidence`，不改变 `clientKind`

**测试改动**：
- `src/server/proxy-core/cliProfiles/registry.test.ts`
  - 新增 `/v1/responsesfoo` 不应命中 `codex`
  - 新增 `/v1/messages + Codex headers` 应保持 `generic`
  - 新增 `claude-cli` headers 无 `metadata.user_id` 仍识别 `claude_code`
- `src/server/routes/proxy/downstreamClientContext.test.ts`
  - 新增 `claude-cli` headers 在 `/v1/messages` 下优先识别 `claude_code`
  - 新增 `/v1/messages + Codex-only headers` 保持 `generic`
  - 新增 `OpenCode` exact / heuristic 覆盖
- `src/server/routes/proxy/downstreamClientContext.routes.test.ts`
  - 新增 `claude-cli` header-based `/v1/messages` failure log 回归
  - 按当前 fork route harness 现状补齐最小测试桩，使该 suite 在当前 surface 依赖链下可运行

### repo-local 差异点

- 当前 fork 明确选择 **完全跟随 upstream**：
  - downstream client detection 层不再保留 `/v1/messages` 的 `codex` 识别
- 本次仍 **不跟** 上游后续的 owner 迁移：
  - 不将 `downstreamClientContext.ts` 下沉到 `src/server/proxy-core/`
  - 不改现有 route / surface import 结构

### 验证结果

- ✅ `npx vitest run src/server/proxy-core/cliProfiles/registry.test.ts` - 10 passed
- ✅ `npx vitest run src/server/routes/proxy/downstreamClientContext.test.ts` - 23 passed
- ✅ `npx vitest run src/server/routes/proxy/downstreamClientContext.routes.test.ts` - 5 passed
- ✅ `npm run repo:drift-check` - Violations: 0

### 结论

- `#429` 现在已从“第二批候选”变为“已完成 repo-local 手工移植”
- 当前 fork 的 downstream client detection 已具备：
  - upstream 对齐的 `Codex` path 边界
  - `Claude Code` header fallback
  - `OpenCode` app-level fingerprint / heuristic
  - 对应的 detection / route logging 回归测试覆盖

---

## 2026-04-06 实施（#441）

**处理结果**：`#441` 已按 repo-local 方案完成手工移植；当前工作区已完成实现，待提交

### 本次落地的上游 Commit

| Commit | 说明 | 合入方式 | 备注 |
|--------|------|---------|------|
| `a789ddf` | add sub2api managed refresh resilience (#441) | 手工移植 | 按本 fork owner 拆成 helper / singleflight / scheduler 三层落地，不直接 cherry-pick 上游 4 个连续提交 |

### 本地实现说明

**P0 helper + failure detail**：
- `src/server/services/sub2apiManagedAuth.ts`
  - 抽出 `isSub2ApiPlatform(...)`
  - 抽出 `isManagedSub2ApiTokenDue(...)`
  - 抽出 `refreshSub2ApiManagedSession(...)`
  - refresh 失败时保留：
    - HTTP status
    - upstream `message / error / error_description`
    - `reason`
    - 原始文本片段 fallback

**P1 singleflight + balance 路径统一**：
- `src/server/services/sub2apiRefreshSingleflight.ts`
  - 新增按 `account.id` 粒度的 refresh singleflight
  - refresh reject 后清理 in-flight，允许后续重试
- `src/server/services/balanceService.ts`
  - Sub2API token 临近过期时的 proactive refresh 改走 singleflight
  - balance `401` 后的一次 retry refresh 改走 singleflight
  - 保持当前 fork 原有的 auto relogin / runtime health / reportExpired 链路不变

**P2 scheduler + startup 接入**：
- `src/server/services/sub2apiRefreshScheduler.ts`
  - 每分钟执行一次 scheduled pass
  - 仅扫描：
    - active account
    - active site
    - `sub2api` platform
  - 仅 refresh 真正 due 的 managed session 账号
  - 采用 bounded concurrency `4`
  - pass 级别使用 in-flight guard，避免重叠 sweep
- `src/server/index.ts`
  - 按当前 fork startup owner reality，在独立后台服务区接入：
    - `startSub2ApiManagedRefreshScheduler()`
    - `stopSub2ApiManagedRefreshScheduler()`

**测试补齐**：
- `src/server/services/balanceService.autoRelogin.test.ts`
  - 新增 refresh 被 upstream 明确拒绝时，错误信息保留 detail 的覆盖
- `src/server/services/sub2apiRefreshSingleflight.test.ts`
  - 覆盖同账号并发 coalesce
  - 覆盖 reject 后允许下次重试
- `src/server/services/sub2apiRefreshScheduler.test.ts`
  - 覆盖 active/due 过滤
  - 覆盖 bounded concurrency
  - 覆盖 scheduled pass stop / wait 语义

### repo-local 差异点

- helper 继续遵守本 fork 当前 proxy owner：
  - 使用 `getProxyUrlFromExtraConfig(...)`
  - 使用 `withSiteRecordProxyRequestInit(...)`
- scheduler 继续挂在 `src/server/index.ts` 的独立后台服务区：
  - 不塞进 `startScheduler()`
  - 不顺势重构现有 scheduler 体系
- 本次没有扩到：
  - settings 开关
  - Web UI
  - schema
  - 其他 managed-token 平台

### 验证结果

- ✅ `npx vitest run src/server/services/balanceService.autoRelogin.test.ts src/server/services/sub2apiRefreshSingleflight.test.ts src/server/services/sub2apiRefreshScheduler.test.ts` - 16 passed
- ✅ `npm run build:server` - 通过
- ✅ `npm run repo:drift-check` - Violations: 0

### 结论

- `#441` 现在已从“第二批候选”变为“已完成 repo-local 手工移植”
- 当前 fork 的 Sub2API managed refresh 已具备：
  - 可复用的 shared helper
  - 更具体的 upstream refresh failure detail
  - 按账号粒度的 refresh singleflight
  - 独立后台 scheduler 主动补刷即将过期的 managed session token
