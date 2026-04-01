# 数据库 Schema 变更记录

> 本文档记录所有相对于上游 metapi 的数据库 Schema 变更。

## 变更总览

| 表 | 列 | 类型 | 默认值 | 用途 |
|----|-----|------|--------|------|
| `account_tokens` | `model_filter_mode` | `text` | `'none'` | 模型过滤模式：`none` / `allow-list` / `deny-list` |
| `account_tokens` | `filtered_models` | `text` | `NULL` | JSON 数组，存储被过滤的模型列表 |

## 详细说明

### `account_tokens.model_filter_mode`

控制单个 Token 的模型过滤行为：

- **`none`**（默认）— 不过滤，使用上级站点的模型配置
- **`allow-list`** — 白名单模式，仅允许 `filtered_models` 中指定的模型
- **`deny-list`** — 黑名单模式，排除 `filtered_models` 中指定的模型

### `account_tokens.filtered_models`

JSON 字符串，格式为 `["model-a", "model-b", ...]`。

与 `model_filter_mode` 配合使用，当 `model_filter_mode` 为 `none` 时此字段被忽略。

## 自动迁移机制

自定义列会在应用启动时**自动检测并添加**，无需手动执行 SQL。迁移逻辑位于：

| 路径 | 作用 |
|------|------|
| `src/server/db/index.ts` → `ensureTokenManagementSchema()` | SQLite 启动路径，通过 `tableColumnExists` 检测后 `ALTER TABLE ADD COLUMN` |
| `src/server/db/accountTokenSchemaCompatibility.ts` | 多方言（SQLite/MySQL/PG）兼容性规范，由 `legacySchemaCompat.ts` 白名单机制授权 |

### 白名单守护

上游的 `legacySchemaCompat.ts` 有一个**安全守护机制**：所有通过 `execSqliteLegacyCompat()` 执行的 ALTER TABLE 语句必须在白名单中，否则会抛出 `Forbidden legacy schema mutation` 错误。

自定义列必须同时在以下两处注册：

1. **`accountTokenSchemaCompatibility.ts`** 的 `ACCOUNT_TOKEN_COLUMN_COMPATIBILITY_SPECS` 数组 — 定义迁移 SQL
2. **`index.ts`** 的 `ensureTokenManagementSchema()` — 执行实际的列检测和添加

## 与上游的兼容性

| 场景 | 影响 |
|------|------|
| 自定义镜像 → 官方镜像 | ✅ 安全。官方代码不 SELECT 自定义列，多余的列被忽略 |
| 官方镜像 → 自定义镜像 | ✅ 安全。启动时自动添加缺失的列 |
| 上游新增同名列 | ⚠️ 需检查默认值和类型是否一致 |

## 相关文件

- `src/server/db/schema.ts` — Drizzle Schema 定义
- `src/server/db/accountTokenSchemaCompatibility.ts` — 多方言迁移规范
- `src/server/db/index.ts` → `ensureTokenManagementSchema()` — SQLite 启动迁移
- `src/server/services/backupService.ts` — 备份导入时需包含自定义列
- `src/server/services/databaseMigrationService.ts` — 跨库迁移时需序列化自定义列
