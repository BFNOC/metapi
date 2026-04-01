# 数据库 Schema 变更记录

> 本文档记录所有相对于上游 metapi 的数据库 Schema 变更。

## 变更总览

### 列变更

| 表 | 列 | 类型 | 默认值 | 用途 |
|----|-----|------|--------|------|
| `account_tokens` | `model_filter_mode` | `text` | `'none'` | 令牌级模型过滤模式：`none` / `allow-list` / `deny-list` |
| `account_tokens` | `filtered_models` | `text` | `NULL` | JSON 数组，存储被过滤的模型列表 |
| `sites` | `model_filter_mode` | `text` | `'deny-list'` | 站点级模型过滤模式：`deny-list` / `allow-list` |
| `sites` | `probe_disabled` | `integer` | `0` | 是否禁用自动模型探测（手动刷新不受影响） |
| `downstream_api_keys` | `excluded_site_ids` | `text` | `NULL` | JSON 数组 `<number>`，排除指定站点的通道 |

### 新增表

| 表 | 用途 | 迁移来源 |
|----|------|----------|
| `site_allowed_models` | 站点白名单模型列表（`allow-list` 模式） | drizzle `0017` + `siteSchemaCompatibility.ts` |
| `site_disabled_models` | 站点黑名单模型列表（`deny-list` 模式） | `siteSchemaCompatibility.ts` |

## 详细说明

### `account_tokens.model_filter_mode`

控制单个 Token 的模型过滤行为：

- **`none`**（默认）— 不过滤，使用上级站点的模型配置
- **`allow-list`** — 白名单模式，仅允许 `filtered_models` 中指定的模型
- **`deny-list`** — 黑名单模式，排除 `filtered_models` 中指定的模型

### `account_tokens.filtered_models`

JSON 字符串，格式为 `["model-a", "model-b", ...]`。

与 `model_filter_mode` 配合使用，当 `model_filter_mode` 为 `none` 时此字段被忽略。

### `sites.model_filter_mode`

控制站点级的模型过滤行为，与 `site_allowed_models` / `site_disabled_models` 表配合使用：

- **`deny-list`**（默认）— 黑名单模式，使用 `site_disabled_models` 表排除指定模型
- **`allow-list`** — 白名单模式，使用 `site_allowed_models` 表限定可用模型

### `sites.probe_disabled`

布尔值（SQLite 存为 integer）。设为 `1` 时禁用自动定时模型发现和站点/令牌探活，但**不阻止**手动刷新模型列表。

### `site_allowed_models` / `site_disabled_models`

与 `sites.model_filter_mode` 配合使用的关联表。结构相同：

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | `integer PK` | 自增主键 |
| `site_id` | `integer FK` | 关联 `sites.id`，级联删除 |
| `model_name` | `text` | 模型名称 |
| `created_at` | `text` | 创建时间 |

唯一约束：`(site_id, model_name)`。

### `downstream_api_keys.excluded_site_ids`

JSON 数组 `<number>`，格式为 `[1, 3, 5]`。指定后，该下游 API Key 的请求路由时会跳过这些站点的通道。

## 自动迁移机制

自定义变更分为两套迁移路径：

### 1. Token 级变更（`account_tokens` 表）

| 路径 | 作用 |
|------|------|
| `src/server/db/index.ts` → `ensureTokenManagementSchema()` | SQLite 启动路径，通过 `tableColumnExists` 检测后 `ALTER TABLE ADD COLUMN` |
| `src/server/db/accountTokenSchemaCompatibility.ts` | 多方言（SQLite/MySQL/PG）兼容性规范，由 `legacySchemaCompat.ts` 白名单机制授权 |

### 2. Site 级变更（`sites` 表 + 关联表）

| 路径 | 作用 |
|------|------|
| `src/server/db/siteSchemaCompatibility.ts` | 多方言兼容性规范：列添加（`SITE_COLUMN_COMPATIBILITY_SPECS`）+ 表创建（`SITE_TABLE_COMPATIBILITY_SPECS`） |
| `src/server/db/index.ts` → `ensureSiteSchemaCompatibility()` | SQLite 启动路径 |

### 3. 标准 Drizzle 迁移

| 迁移文件 | 变更 |
|----------|------|
| `drizzle/0017_model_filter_mode.sql` | `sites.model_filter_mode` 列 + `site_allowed_models` 表 |
| `drizzle/0018_excluded_site_ids.sql` | `downstream_api_keys.excluded_site_ids` 列 |

### 白名单守护

上游的 `legacySchemaCompat.ts` 有一个**安全守护机制**：所有通过 `execSqliteLegacyCompat()` 执行的 ALTER TABLE 语句必须在白名单中，否则会抛出 `Forbidden legacy schema mutation` 错误。

自定义列必须同时在以下两处注册：

1. **`accountTokenSchemaCompatibility.ts`** 的 `ACCOUNT_TOKEN_COLUMN_COMPATIBILITY_SPECS` 数组 — 定义迁移 SQL
2. **`index.ts`** 的 `ensureTokenManagementSchema()` — 执行实际的列检测和添加

## 与上游的兼容性

| 场景 | 影响 |
|------|------|
| 自定义镜像 → 官方镜像 | ✅ 安全。官方代码不 SELECT 自定义列/表，多余的列被忽略 |
| 官方镜像 → 自定义镜像 | ✅ 安全。启动时自动添加缺失的列和表 |
| 上游新增同名列 | ⚠️ 需检查默认值和类型是否一致 |

## 相关文件

- `src/server/db/schema.ts` — Drizzle Schema 定义
- `src/server/db/accountTokenSchemaCompatibility.ts` — 令牌级多方言迁移规范
- `src/server/db/siteSchemaCompatibility.ts` — 站点级多方言迁移规范
- `src/server/db/index.ts` — SQLite 启动迁移入口
- `src/server/services/backupService.ts` — 备份导入时需包含自定义列
- `src/server/services/databaseMigrationService.ts` — 跨库迁移时需序列化自定义列
