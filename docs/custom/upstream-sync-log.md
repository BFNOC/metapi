# 上游同步记录

> 记录每次从上游 `cita-777/metapi` 同步的变更。

## 2026-04-03 同步

**上游已审阅到**：`63f6b07`（upstream/main HEAD）

### 已合入的 Commit

| Commit | 说明 | 合入方式 | 备注 |
|--------|------|---------|------|
| `b9b553d` | fix: sqlite migration journal recovery (#400) | `git cherry-pick` | 2026-04-03 合入，本地提交 `2d0ba35` |
| `63f6b07` | cap sqlite migration recovery retries (#410) | `git cherry-pick` | 2026-04-03 合入，本地提交 `28e1b11` |

### 待合入的 Commit（已分析，待执行）

| Commit | 说明 | 优先级 | 冲突预估 |
|--------|------|--------|----------|
| `6ad9ec6` | strip codex responses max_output_tokens (#399) | P2 | ⚠️ 高冲突，upstreamEndpoint.ts 已分叉 1434 行 |

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

### 待定的 Commit（需进一步评估）

| Commit | 说明 | 待定原因 |
|--------|------|----------|
| `2be0603` | fix expired connection health recovery (#393) | 10 文件 +406/-17 行，功能价值高（过期 API Key 自动恢复），但依赖 #392（已建议跳过），需评估是否手工移植核心逻辑 |
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
