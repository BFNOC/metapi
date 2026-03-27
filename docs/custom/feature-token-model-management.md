# Token 级模型管理与探活功能

> 自定义功能：在原有站点级模型管理基础上，增加 Token 级粒度的模型过滤与健康探测。

## 功能概述

### Token 级模型管理

允许对每个 API Token 独立配置可用模型列表，实现更精细的路由控制。

**使用场景**：
- 某个 Token 只购买了特定模型额度，限制只路由这些模型
- 不同 Token 分配给不同用途（如 GPT 专用 Token、Claude 专用 Token）
- 排除某个 Token 上响应慢或不稳定的模型

**配置方式**：

| `model_filter_mode` | 行为 |
|---------------------|------|
| `none` | 继承站点配置，不做额外过滤 |
| `allow-list` | 仅暴露 `filtered_models` 中的模型 |
| `deny-list` | 排除 `filtered_models` 中的模型 |

### 模型探活 (Probe)

对 Token 下的模型进行健康检查，记录可用性和延迟。

**特性**：
- 批量探测，支持可配置的批次间隔（防风控）
- 轻量级探活 prompt（避免触发 AI 安全审查）
- 探活结果可点击查看详情（SSE 流式响应 / 错误信息）
- 结果存储在 `token_model_availability` 表

## 涉及的代码改动

### 后端

| 文件 | 改动 |
|------|------|
| `src/server/db/schema.ts` | `accountTokens` 新增 `modelFilterMode`、`filteredModels` 列 |
| `src/server/routes/api/accountTokens.ts` | 新增 `/allowed-models` GET/PUT 接口 |
| `src/server/routes/api/sites.ts` | 新增 `/probe-models` 探活接口 |
| `src/server/services/modelProbeService.ts` | **新文件** — 模型探活核心逻辑 |
| `src/server/services/modelService.ts` | 扩展 Token 级模型可见性计算 |

### 前端

| 文件 | 改动 |
|------|------|
| `src/web/pages/accounts/AccountModelsModal.tsx` | Token 模型管理弹窗 |
| `src/web/pages/token-routes/RouteCard.tsx` | 路由卡片 UI 优化 |
| `src/web/pages/Accounts.tsx` | 账号页集成模型管理入口 |
| `src/web/components/ModernSelect.tsx` | 下拉组件增强（Portal 渲染防裁剪） |

### 数据库

| 文件 | 改动 |
|------|------|
| `src/server/db/accountTokenSchemaCompatibility.ts` | 新增列的跨方言迁移规范 |
| `src/server/db/index.ts` | SQLite 启动迁移逻辑 |
| `src/server/services/backupService.ts` | 备份/导入兼容自定义列 |

## API 接口

### 获取 Token 允许的模型列表

```
GET /api/account-tokens/:tokenId/allowed-models
```

**响应**：
```json
{
  "tokenId": 1,
  "modelFilterMode": "allow-list",
  "filteredModels": ["gpt-5.2", "gpt-5.4", "claude-4-sonnet"],
  "effectiveModels": ["gpt-5.2", "gpt-5.4", "claude-4-sonnet"]
}
```

### 更新 Token 模型配置

```
PUT /api/account-tokens/:tokenId/allowed-models
Content-Type: application/json

{
  "modelFilterMode": "allow-list",
  "filteredModels": ["gpt-5.2", "gpt-5.4"]
}
```

### 探活站点模型

```
POST /api/sites/:siteId/probe-models

{
  "tokenId": 1,
  "models": ["gpt-5.2", "gpt-5.4"],
  "delayMs": 2000
}
```

## 路由影响

Token 级模型过滤在 `TokenRouter.selectChannel()` 阶段生效：

1. 路由器筛选匹配 model 的 channel
2. 对每个 channel，检查其 Token 的 `modelFilterMode`
3. 根据 allow-list / deny-list 过滤不符合的 channel
4. 从剩余 channel 中按权重/延迟选择最优

这保证了只有明确允许的模型才会被路由到对应的 Token。
