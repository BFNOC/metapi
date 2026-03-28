# 上游同步记录

> 记录每次从上游 `cita-777/metapi` 同步的变更。

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
| *(pending)* | refactor: 精简模型发现 — Session 连接跳过账号级发现 + probeDisabled 手动刷新放行 |
| *(pending)* | feat: API Key 连接新增探活功能 + 探活模型选择改为多选框 |
