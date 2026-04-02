# 上游同步记录

> 记录每次从上游 `cita-777/metapi` 同步的变更。

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

### 尝试但中止的 Commit

| Commit | 说明 | 中止原因 |
|--------|------|----------|
| `ace5ddd` | fix: edit payload clearing boundaries (#381) | 5 文件冲突：accountsRoutePayloads.ts/monitor.test.ts 本地已删除（modify/delete），tokens.ts/downstreamApiKeys.ts/tokens.route-update-rebuild.test.ts 内容冲突 |

### 跳过的 Commit（已审阅，不需要）

| Commit | 说明 | 跳过原因 |
|--------|------|----------|
| `6e04db6` | fix: site-created dialog cancel cleanup (#341) | SiteCreatedModal 本地已重构为 CenteredModal，补丁无法 apply |
| `6b19d06` | fix: empty stream success handling (#343) | 24 文件中 2 个 surface 文件冲突，需专项移植（后续处理） |
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
| `1e0dffe` | fix mysql insert boundary handling (#364) | 20 文件 +544 行，tokens.ts/backupService.ts 等 6 文件拒绝，需专项移植 |
| `532be86` | add route cooldown controls (#365) | 与本地通道冷却重置功能重叠，需对比评估（见审阅报告） |
| `21d92e1` | recognize structured oauth accounts in routing (#369) | OAuth 功能 |
| `37a86d1` | background route decision refresh (#370) | 路由决策后台刷新 |
| `6e21f91` | add route priority left rail (#371) | 路由优先级 UI 系列 |
| `76c85d0` | split site API endpoint pool (#373) | 体量巨大(+7220)，上游架构演进方向，暂不合入 |
| `ce77bde` | align route priority drag preview (#375) | 路由优先级 UI 系列 |
| `1133846` | restore route priority drag behavior (#376) | 路由优先级 UI 系列 |
| `596d1b9` | proactive channel probes + load-aware routing (#330) | 最大 PR(+6366)，三个模式值得学习但不直接合入（见审阅报告） |
| `bcd758e` | harden background task completion waits (#382) | 测试改进，依赖 #330 |
| `180d17a` | add proxy first-byte timeout and log badges (#383) | 含 schema 变更(migration 0019)，值得后续单独引入 |
| `52c6ff5` | route codex websocket through site api endpoints (#386) | 依赖 #373 |
| `ed2783e` | fix route detail dropdown clipping (#388) | UI 小修 |
| `1407f75` | add Fedora desktop rpm packaging (#390) | RPM 打包 |

### 值得后续关注的大型 PR（已深度分析）

- **#330** (主动探活+负载感知路由) — 三个可借鉴模式：四态探测判定、恢复闭环、负载乘子
- **#365** (路由冷却控制) — 与本地实现重叠，建议补 cooldown max cap 和 route 级批量清冷却
- **#383** (首字节超时) — 对挂死链路有效，建议在 protocol-affinity 阶段参考
- **#373** (Site API Endpoint Pool) — 上游架构演进方向，长期跟踪

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

