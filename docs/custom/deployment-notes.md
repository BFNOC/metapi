# 自定义镜像部署指南

## 构建与推送

```bash
# 设置代理（如需要）
export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 all_proxy=socks5://127.0.0.1:7897

# 构建并推送到 Docker Hub
docker buildx build --platform linux/amd64 -f docker/Dockerfile -t hfxmci/metapi:latest --push .
```

## Docker Compose 配置

```yaml
services:
  metapi:
    # image: cita777/metapi:latest      # 官方镜像（备用）
    image: hfxmci/metapi:latest          # 自定义镜像
    volumes:
      - ./data:/app/data
    ports:
      - "4000:4000"
    restart: unless-stopped
```

## 镜像切换

| 操作 | 命令 |
|------|------|
| 切换到自定义 | 修改 `image:` → `hfxmci/metapi:latest`，然后 `docker compose up -d` |
| 切回官方 | 修改 `image:` → `cita777/metapi:latest`，然后 `docker compose up -d` |

> **重要**：切换前建议备份 `./data/hub.db`。

## 首次部署到现有数据库

自定义镜像首次部署到使用官方镜像创建的数据库时，会**自动执行**以下迁移：

1. 检测 `account_tokens` 表是否存在 `model_filter_mode` 列
2. 如不存在，执行 `ALTER TABLE account_tokens ADD COLUMN model_filter_mode text DEFAULT 'none'`
3. 检测 `filtered_models` 列，同理自动添加

无需手动干预，启动日志中会看到迁移执行记录。

## 回退兼容性

| 方向 | 数据 | 功能 |
|------|------|------|
| 自定义 → 官方 | ✅ 数据保留（自定义列被忽略） | ❌ Token 模型管理/探活不可用 |
| 官方 → 自定义 | ✅ 自动迁移补列 | ✅ 所有功能恢复 |

## 常见问题

### 500 错误：`Failed query: select ... model_filter_mode`

**原因**：数据库缺少自定义列（旧数据库未迁移）。

**解决**：重启容器即可触发自动迁移。如仍不行，手动执行：

```sql
ALTER TABLE account_tokens ADD COLUMN model_filter_mode text DEFAULT 'none';
ALTER TABLE account_tokens ADD COLUMN filtered_models text;
```

### `Forbidden legacy schema mutation`

**原因**：新增的列未注册到白名单。

**解决**：确保 `accountTokenSchemaCompatibility.ts` 的 `ACCOUNT_TOKEN_COLUMN_COMPATIBILITY_SPECS` 包含对应的列定义。
