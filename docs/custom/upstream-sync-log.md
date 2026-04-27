# 上游同步记录

> 记录每次从上游 `cita-777/metapi` 同步的变更。仅保留未合入的决策和待定项；已合入的记录见归档。

## 当前状态

**上游已审阅到**：`262651a`（`upstream/main` HEAD，2026-04-27 审阅，#494 merge，实际合入 2026-04-17）

## 归档

| 时间范围 | 文件 | 涵盖内容 |
|----------|------|---------|
| 2026-03-27 ~ 2026-03-31 | [2026-03.md](upstream-sync/2026-03.md) | 分叉点 #283/#284、#295、#336/#335/#302 |
| 2026-04-02 ~ 2026-04-05 | [2026-04-early.md](upstream-sync/2026-04-early.md) | 9 个 cherry-pick + #330/#365/#383/#399/#404 手工移植 + #400/#410 cherry-pick |
| 2026-04-06 ~ 2026-04-12 | [2026-04-late.md](upstream-sync/2026-04-late.md) | v1.3.0 审阅 + #422/#439/#426/#429/#441/#444/#464/#473/#474/#451 实施 + 569a15e 拆子线 |

---

## 长期跳过策略

以下分类在多次审阅中反复出现，除非条件变化否则继续跳过。

- **OAuth 线**：#296, #298, #307, #311, #316, #369, #421, #433, #440, #443, #445, #450 — 本地无 OAuth 使用场景
- **Proxy Debug Tracing 线**：#299, #309, #312, #313, #325, #327, #331, #442 — 不需要代理调试追踪
- **K3s / Update Center**：#314, #317, #318, #326, #333, #344, #349, #361, #494(UpdateCenter 部分) — K3s 基础设施
- **路由优先级 UI 系列**：#350, #371, #375, #376, #467 — 本地 TokenRoutes 已走不同架构
- **Snapshot-first 架构**：#457 (+21732 行) + #471 — 单租户收益不足，估计 3-5 人天
- **expired recovery**：#393, #421 — 单租户场景不适用
- **Codex/CodingPlan 初始化**：#351, #357, #363 — 不需要
- **发版 / 打包 / 文档**：RPM, Docker ARM, release tests, readme, docs — 不影响功能
- **Transformer Bridge 重构**：#494 内含，~9000 行纯架构拆分（requestBridge/responseBridge/streamBridge），无新用户功能
- **upstreamEndpoint → services 拆分**：#494 内含，owner 迁移重构，本地 protocol affinity 等定制冲突面大

---

## 待定 / 可选

- **Codex 兼容层改进**（#494 内含）：codexClientFamily 检测、session continuation、compact responses 增强 — 按实际 Codex 使用痛点需要再 selective port

---

## 实施记录

### #494 — dev snapshot 发布到 main（2026-04-27 审阅）

**PR 规模**：141 文件，+12979/-5798 行，2026-04-17 合入

**分诊结论**：

| 分类 | 判断 | 说明 |
|------|------|------|
| `6cca74b` LobeHub brand detection 扩展 | ✅ 已有等价覆盖 | 之前合入 #464 时已完整移植 `modelBrand.ts` + `brandMatcher.ts` + `brandRegistry.ts`，对比上游完全一致 |
| `544324e` payload-rule protocol list 恢复 | ✅ 已有等价覆盖 + 补齐回归测试 | Settings.tsx 共享导入在合入 #473/#474 时已完成；本次仅补全上游新增的 protocol option set 回归测试用例 |
| Transformer Bridge 重构（~9000 行） | ⚪ 暂缓 | 纯架构拆分，无用户可见功能，加入长期跳过 |
| upstreamEndpoint → services 拆分（~2400 行） | ⚪ 暂缓 | owner 迁移，本地定制冲突面大，加入长期跳过 |
| Codex 兼容层改进 | 🟡 可选 | codexClientFamily/session continuation/compact，加入待定 |
| UpdateCenter / CI / Docker / Scripts / OAuth | ❌ 跳过 | 长期跳过策略继续适用 |

**本次实际代码变更**：补全 `settings.payload-rules.test.tsx` 一个回归测试用例

**验证**：
- `settings.payload-rules` 7/7 通过
- `brandMatcher` + `BrandIcon` 14/14 通过
- `repo:drift-check` 无新增 violation

---

## 参考判例

以下判例的决策理由有长期参考价值，未来条件变化时可重新评估。

<details>
<summary>#373 Site API Endpoint Pool（暂不合入）</summary>

**核心架构**：把 site 拆成管理面板地址 + AI 请求地址池（`siteApiEndpoints` 表），支持同一站点多个 API 入口自动轮转 + endpoint 级 cooldown/故障隔离。

**改动范围**：49 文件 +7220/-980 行。

**不合入原因**：
1. 当前站点数量有限，多入口需求不强烈
2. 16 个核心文件与本地分叉严重，手工移植工作量大
3. 后续直接依赖仅 #386

**值得借鉴的思路**：
- 站点管理地址与请求地址解耦
- endpoint 级故障分类：retryable(408/429/5xx) 自动轮转+cooldown，non-retryable(400/401/403) 直接抛错
- `runWithSiteApiEndpointPool` 统一包装模式

**未来分相位路径**：Phase 0 新建表+service → Phase 1 discovery 接入 → Phase 2 direct routes → Phase 3 surfaces → Phase 4 Sites UI

</details>

<details>
<summary>#393 Expired Connection Recovery（不适合当前部署）</summary>

**功能**：账号 `expired` 时替换新 API Key 后自动刷新模型并激活。

**不合入原因**：本地为单租户/小团队模式，所有 API Key 由管理员集中管理，主要后端为 new-api（余额制）。`expired` 的所有场景（余额不足→需后台充值、账号被封→换 key 无意义、手动删除→不想用）都不适合通过"替换 key"恢复。

**重新评估条件**：扩展为多租户或增加其他 API 提供商时。

</details>

<details>
<summary>#457 Snapshot-first Admin Reads（单租户收益不足）</summary>

82 文件 +21732/-4974 行。引入全新 snapshot-first 数据加载体系，dashboard/accounts/proxy logs 三页面已高度分叉（合计 4284 行定制代码），手工移植估计 3-5 人天。如未来出现性能瓶颈，可基于现有 `progressiveRender.ts` 和 `modelsMarketplaceCache` 模式按需优化。

</details>
