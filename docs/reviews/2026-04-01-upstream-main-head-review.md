# 代码审查记录（2026-04-01）

## 审查范围

- 基线：`upstream/main..HEAD`
- 只审查你**修改过的文件中的新增/修改 hunks**，未对未改动的历史代码做通用巡检
- 审查方式：4 个 subagents 并行审查 + 主线程复核高风险项

## 主结论

这次改动里有一批**可以直接定性的真实问题**，主要集中在：

1. 模型发现 / 路由重建链路
2. OAuth / 代理链路
3. 通道路由配置去重
4. 备份恢复一致性
5. 自有脚本与自有文档

同时还有几项是**明显行为回归，但是否算 BUG 取决于你是否有意移除某些能力**，我单独放到“待确认项”里。

---

## 已确认问题

### 1. `probeDisabled` 会先清空模型可用性，再直接跳过刷新

- 严重级别：高
- 位置：
  - `src/server/services/modelService.ts:320`
  - `src/server/services/modelService.ts:354`
  - `src/server/services/modelService.ts:372`
- 结论：
  - 当前逻辑先执行 `clearExistingAvailability()`
  - 然后才检查 `site.probeDisabled`
  - 一旦站点开启“禁用模型探测”，这次刷新会返回 `skipped`
  - 但账号现有的 `modelAvailability` / `tokenModelAvailability` 已经被清空
- 影响：
  - 后续重建路由时会把自动路由 / 自动通道一起删掉
  - 这是明确的功能回归

### 2. Gemini CLI OAuth 校验不再继承站点代理

- 严重级别：高
- 位置：
  - `src/server/services/platformDiscoveryRegistry.ts:189`
  - `src/server/services/modelService.ts:535`
- 结论：
  - `validateGeminiCliOauthConnection()` 现在只读取 `account.extraConfig` 里的代理
  - 调用方也不再传 `site`
  - 站点级 `proxyUrl/useSystemProxy` 因此失效
- 影响：
  - 依赖站点代理访问 Google API 的 Gemini CLI OAuth 账号，会在模型校验/刷新时直连失败

### 3. 新增通道时，`tokenId: 0` 可以绕过重复通道校验

- 严重级别：高
- 位置：
  - `src/server/routes/api/tokens.ts:1170`
  - `src/server/routes/api/tokens.ts:1186`
  - `src/server/routes/api/tokens.ts:1197`
- 结论：
  - 代码先把 `tokenId <= 0` 规范化成 `null`
  - 但重复校验仍然拿原始 `body.tokenId`
  - 实际入库又使用规范化后的 `normalizedTokenId`
- 影响：
  - 当已有 `(accountId, null, sourceModel)` 通道时，再传 `tokenId: 0` 仍可重复插入等价通道

### 4. 备份恢复会丢失 token 级模型过滤配置

- 严重级别：高
- 位置：
  - `src/server/services/backupService.ts:1294`
  - `src/server/services/backupService.ts:1590`
  - `src/server/routes/api/accountTokens.ts:1053`
- 结论：
  - 备份导出时拿的是完整 `accountTokens` 行
  - 但恢复时只回写旧字段，没有写回 `modelFilterMode` / `filteredModels`
- 影响：
  - 恢复后 token 的 allow-list / deny-list 配置丢失
  - 路由行为会静默回退

### 5. 站点 allow-list 为空时，探活弹窗会错误地默认勾选全部模型

- 严重级别：中
- 位置：
  - `src/web/components/ModelProbeModal.tsx:105`
  - `src/web/components/ModelProbeModal.tsx:139`
- 结论：
  - 站点是 `allow-list` 模式但白名单为空时，没有走“选空”
  - 而是落入默认分支，`setSelectedModels(new Set(modelList.map(...)))`
- 影响：
  - 前端探活集合与真实可路由集合不一致
  - 会额外消耗探活请求

### 6. OAuth provider 站点懒创建存在并发唯一键冲突窗口

- 严重级别：中
- 位置：
  - `src/server/services/oauth/service.ts:148`
- 结论：
  - `ensureOauthSite()` 采用“先查后插”
  - 当前没有对 `sites(platform,url)` 唯一键冲突做恢复
- 影响：
  - 新库上同一 provider 首次并发 OAuth 回调时，可能有一个请求直接撞唯一约束失败

### 7. 仓库里提交了真实样式的 Bearer Token

- 严重级别：高
- 位置：
  - `batch_set_allowlist.sh:8`
- 结论：
  - 脚本把 Bearer Token 明文写进仓库
- 影响：
  - 如果该值仍有效，就是直接的凭据泄漏
  - 即使失效，也会持续诱导后续把管理令牌硬编码进仓库

### 8. `check_tokens.ts` 使用了本机绝对路径

- 严重级别：中
- 位置：
  - `check_tokens.ts:1`
  - `check_tokens.ts:2`
- 结论：
  - 脚本直接 import `/Users/chaos/...`
- 影响：
  - 换机器、换路径、上 CI 都会直接失效
  - 还会把本机目录结构暴露进仓库

### 9. 自有 Schema 变更文档未同步新增字段

- 严重级别：中
- 位置：
  - `docs/custom/schema-changes.md:3`
  - `drizzle/0017_model_filter_mode.sql:1`
  - `drizzle/0017_model_filter_mode.sql:3`
  - `drizzle/0018_excluded_site_ids.sql:1`
- 结论：
  - 文档声称记录“所有相对上游的 Schema 变更”
  - 但漏掉了：
    - `sites.model_filter_mode`
    - `site_allowed_models`
    - `downstream_api_keys.excluded_site_ids`
- 影响：
  - 运维按文档审计或迁移时会低估真实 schema drift

### 10. 自定义部署文档默认只构建 amd64，但没明确提示单架构后果

- 严重级别：中
- 位置：
  - `docs/custom/deployment-notes.md:10`
- 结论：
  - 文档固定使用 `docker buildx build --platform linux/amd64`
  - 但没有明确说明这样只会产出 amd64 manifest
- 影响：
  - ARM 设备按文档构建/推送后，拉取或运行会失败，或退化到仿真

---

## 待确认项

这些项来自 subagents，表现为**明显行为回归**，但如果你本来就是有意删除能力，那它们更像“产品取舍”而非 BUG。

### 1. Proxy Debug Trace 的前端工作流被整体移除

- 相关位置：
  - `src/web/pages/ProxyLogs.tsx`
  - `src/web/api.ts`
- 风险：
  - 之前依赖 WebUI 做代理链路精细排障的能力消失

### 2. Update Center 的前端入口和事件跳转被移除

- 相关位置：
  - `src/web/pages/About.tsx`
  - `src/web/pages/helpers/navigationFocus.ts`
- 风险：
  - 如果你并不是故意下掉更新中心，那这是明显可用性回归

### 3. OAuth 流程的自定义代理能力可能被整体拆掉了，但 provider 仍宣称支持原生代理

- 相关位置：
  - `src/server/routes/api/oauth.ts`
  - `src/server/services/oauth/service.ts`
  - `src/server/services/oauth/*.ts`
- 说明：
  - 这一项需要结合你的产品意图判断
  - 但从代码面看，前后端声明与实际行为已经出现不一致

### 4. 路由页缺少分组提示被硬编码屏蔽

- 相关位置：
  - `src/web/pages/token-routes/RouteCard.tsx`
  - `src/web/pages/TokenRoutes.tsx`
- 风险：
  - 如果这不是临时隐藏，就是明确的可用性回退

---

## Subagent 原始输出

### A. 服务端代理 / 路由 / 健康模型

```text
1. 高 [modelService.ts:354] 在任何刷新前先执行了 clearExistingAvailability()，而新增的 probeDisabled 提前返回发生在 [modelService.ts:372]。触发条件是站点开启“禁用模型探测”后走常规刷新。结果是该账号现有的 modelAvailability / tokenModelAvailability 会先被清空，再返回 skipped；后续重建路由时会把自动路由/通道一起删掉，这是新增分支引入的实质性回归。

2. 高 [platformDiscoveryRegistry.ts:189] 现在只用 getProxyUrlFromExtraConfig(input.account.extraConfig) 构造代理，请求不再走站点级代理；调用方也把 site 参数去掉了，[modelService.ts:535]。触发条件是 Gemini CLI OAuth 账号依赖站点上的 proxyUrl/useSystemProxy 才能访问 Google API、但账号自身没配代理。影响是模型校验/刷新会直接走直连并失败，属于明确的网络行为回归。

3. 中 [endpointFlow.ts:58] 删除了 disableCrossProtocolFallback 输入，且 [endpointFlow.ts:182] 之后会无条件按 shouldDowngrade 继续跨协议回退。触发条件是原来依赖该开关禁止从 /v1/responses 继续降级到 /v1/chat/completions 或 /v1/messages 的部署。影响是旧配置被静默忽略，请求语义和上游调用次数都会改变。

4. 中 [tokenRouter.ts:192] 和 [tokenRouter.ts:204] 把运行时健康从“站点全局 + 站点/模型”收缩成只按 siteId + modelName 记账，而失败写入点仍是 [tokenRouter.ts:1833]、[tokenRouter.ts:1854]、[tokenRouter.ts:1895]。触发条件是站点/账号级故障，如 401/403/402、quota exhausted、号池见底。影响是同一站点上的其他模型不会被一起避让，而是继续被选中直到逐个失败，错误会跨模型扩散。

5. 中 [tokens.ts:1173] 先把 tokenId <= 0 规范化成 null，但重复校验仍使用原始请求值 [tokens.ts:1188]，真正入库时却写入规范化后的值 [tokens.ts:1199]。触发条件是新增通道时传 tokenId: 0 表示“跟随默认令牌”，而库里已经有等价的 null 通道。影响是重复校验被绕过，能插入重复 channel。

6. 低 [upstreamEndpoint.ts:78] 和 [upstreamEndpoint.ts:716] 现在在 src/server/routes/proxy 内持有可变的端点运行时状态，并对外导出状态写入函数；这些函数又被非 route 层直接引用，例如 [chatSurface.ts:7]。这违反了仓库里“route 只是适配层、被跨层复用的 helper 不应放在 routes/proxy”的边界规则。
```

### B. 服务端业务 / API / DB / OAuth

```text
1. 严重 OAuth 代理链路被这次改动整体拆掉了，但 Codex/Claude/Gemini 仍继续声明 supportsNativeProxy。触发条件：实例需要通过系统/站点/账号代理访问 OAuth 上游，或已有 OAuth 账号刷新 token。影响：授权码交换、refresh token，以及 Gemini/Antigravity 的后续 Google API 调用都会改成直连公网；在受限网络下会直接导致登录、重绑、自动刷新失败，而且前端仍会暴露一个后端已经忽略的“原生代理”能力。

2. 严重 DB schema 已新增 sites.probe_disabled 和 account_tokens.model_filter_mode/filtered_models，但 MySQL/Postgres 生成产物、schema contract、跨库迁移写入逻辑都没有同步。

3. 高 备份导入会丢失 token 级模型过滤配置。

4. 中 OAuth provider 站点的懒创建失去了唯一冲突恢复，首次并发回调会偶发失败。

5. 低 /api/search 不再按 sites.platform 命中站点、账号和账号令牌。
```

### C. WebUI

```text
1. 高：代理调试追踪的整条 WebUI 工作流被删掉了，现在线上排查协议兼容/重试链路时没有前端入口可用。

2. 高：更新中心在 WebUI 中已经没有剩余入口，连事件跳转也一起失效。

3. 中：OAuth 授权流不再支持自定义代理，导致需要代理环境的新建/重绑授权无法从该页完成。

4. 中：模型探活在 allow-list 为空时会默认勾选“全部模型”，与实际过滤语义相反。

5. 中：路由卡片把“缺少分组”提示硬编码成不可达分支，分组缺失问题会被静默隐藏。
```

### D. 文档 / 工程配置 / 迁移

```text
1. 高危: batch_set_allowlist.sh:8 把一个具体的 Bearer Token 直接提交进仓库了。

2. 中危: check_tokens.ts:1 和 check_tokens.ts:2 使用了写死的本机绝对路径 /Users/chaos/...。

3. 中危: docs/custom/schema-changes.md 声称记录所有相对于上游 metapi 的数据库 Schema 变更，但遗漏了 sites.model_filter_mode、site_allowed_models、downstream_api_keys.excluded_site_ids。

4. 中危: docs/custom/deployment-notes.md 把自定义镜像构建命令固定成 --platform linux/amd64，但没有注明该镜像因此只产出 amd64 manifest；这与仓库仍公开宣称的多架构 Docker 支持不一致。
```

---

## 备注

- 本文档的“已确认问题”是我结合 subagent 结论后再次做过代码复核的版本
- “待确认项”建议你结合自己的改动意图再判定一次
- 如果你要，我下一步可以直接按这个文档顺序继续修
- 2026-04-01 已完成一次处置复核：#7、#8 已通过重写 Git 历史彻底清除，4 个“待确认项”均已得到产品侧确认并关闭
- 当前剩余待修项为 #1、#3、#4、#5；#2、#6 暂不修复，#9、#10 转为文档补充项

## 复核与处置记录（2026-04-01）

### 已确认问题（#1 - #10）

| 编号 | 状态 | 处置记录 |
| --- | --- | --- |
| #1 | 待修复 | `modelService.ts` 中 `clearExistingAvailability()` 先于 `probeDisabled` 跳过判断执行，导致“禁用模型探测”站点刷新时先清空模型可用性再返回 `skipped`。确认按方案修复：将清理动作移动到 `isSiteDisabled`、`probeDisabled`、account status 等前置跳过检查之后。 |
| #2 | 不修复 | Gemini CLI OAuth 不继承站点代理。用户当前不使用 OAuth 功能，暂不在本轮处理，等待上游后续修复。 |
| #3 | 待修复 | `tokens.ts` 对 `tokenId <= 0` 已规范化为 `normalizedTokenId`，但重复校验仍误用原始 `body.tokenId`。确认按方案修复：重复校验改为使用 `normalizedTokenId`，避免 `tokenId: 0` 绕过重复校验。 |
| #4 | 待修复 | 备份导出已包含 `accountTokens.modelFilterMode` / `filteredModels`，但恢复逻辑未写回这两个字段。确认按方案修复：在 `backupService.ts` 的 `importAccountsSection` 中补齐这两个字段的恢复。 |
| #5 | 待修复 | `ModelProbeModal.tsx` 在 `allow-list` 且白名单为空时落入默认分支，错误地默认全选全部模型。确认按方案修复：`allow-list` 且 `filtered.length === 0` 时应恢复为空集。 |
| #6 | 不修复 | OAuth 站点并发唯一键冲突。用户当前不使用 OAuth 功能，暂不在本轮处理，等待上游后续修复。 |
| #7 | 已修复 | `batch_set_allowlist.sh` 提交了 Bearer Token 明文。已通过 `git filter-repo` 从 Git 全部历史中彻底删除 `batch_set_allowlist.sh`，并已 force push 到 GitHub；该文件现已加入 `.gitignore`。 |
| #8 | 已修复 | `check_tokens.ts` 硬编码本机绝对路径 `/Users/chaos/...`。已随 #7 一并通过 `git filter-repo` 从 Git 全部历史中彻底删除，并已加入 `.gitignore`。 |
| #9 | 已修复 | 已在 `docs/custom/schema-changes.md` 补记 `sites.model_filter_mode`、`sites.probe_disabled`、`site_allowed_models` / `site_disabled_models` 表、`downstream_api_keys.excluded_site_ids`，含详细说明和迁移路径。 |
| #10 | 已修复 | 已在 `docs/custom/deployment-notes.md` 添加架构警告：说明 `--platform linux/amd64` 仅产出 amd64 manifest，ARM 设备需改用 `linux/amd64,linux/arm64`。 |

### 待确认项（全部关闭）

| 编号 | 结论 | 说明 |
| --- | --- | --- |
| 待确认 #1 | 关闭 | Proxy Debug Trace 前端工作流移除为用户明确确认的不需要功能，不按缺陷处理。 |
| 待确认 #2 | 关闭 | Update Center 前端入口移除不属于本 fork 回归；该能力来自上游后续新增功能，用户未合并。 |
| 待确认 #3 | 关闭 | OAuth 自定义代理能力移除同样属于上游后续新增能力未合并，不作为本次回归问题继续处理。 |
| 待确认 #4 | 关闭 | 路由页分组提示为有意隐藏，代码注释 `[CUSTOM] 隐藏缺少分组提示 — 手动审核模式下不需要` 已明确说明产品意图。 |
