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

### 禁用通道返回「该令牌不支持当前模型」(400)

**原因**：`PUT /api/channels/:channelId` 在每次更新时都会执行 `tokenSupportsModel()` 检查，而服务器上 Token 可能缺少模型探测数据（`token_model_availability` 表为空）。本地环境因为做过探测所以不受影响。

**解决**：已修复（2026-03-27）。`tokenSupportsModel` 检查现在仅在 `tokenId` 被修改时才执行，禁用/启用等操作不再触发此验证。

---

## 登录会话配置

自定义镜像的登录会话时长已从默认的 **12 小时** 延长至 **30 天**：

| 配置项 | 文件 | 默认值 | 自定义值 |
|--------|------|--------|----------|
| Web 会话时长 | `src/web/authSession.ts` | 12h | 30 天 |
| Monitor Cookie Max-Age | `src/server/routes/api/monitor.ts` | 2h (7200s) | 30 天 (2592000s) |

## 上游请求头安全

自定义镜像会**自动剥离**以下可能泄漏客户端真实 IP 的请求头，确保上游仅看到代理的 TCP 源 IP：

`x-forwarded-for`、`x-forwarded-proto`、`x-forwarded-host`、`x-forwarded-port`、`x-real-ip`、`cf-connecting-ip`、`cf-ipcountry`、`cf-ray`、`cf-visitor`、`true-client-ip`、`x-client-ip`、`x-cluster-client-ip`、`forwarded`、`via`

> **注意**：`upstreamEndpoint.ts` 中的 `BLOCKED_PASSTHROUGH_HEADERS` 集合控制此行为。
