# 自定义镜像部署指南

## 构建与推送

```bash
# 设置代理（如需要）
export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 all_proxy=socks5://127.0.0.1:7897

# 构建并推送到 Docker Hub
docker buildx build --platform linux/amd64 -f docker/Dockerfile -t hfxmci/metapi:latest --push .
```

> **⚠️ 注意**：上述命令仅构建 **amd64** 单架构镜像。ARM 设备（如 Apple Silicon Mac、树莓派、部分 VPS）拉取后会走 QEMU 仿真，性能显著下降。如需多架构支持，改为 `--platform linux/amd64,linux/arm64`。

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

## 通道优先级与权重手动配置

自定义镜像支持在路由管理 UI 中手动编辑通道的 **优先级 (Priority)** 和 **权重 (Weight)**：

| 字段 | 范围 | 说明 |
|------|------|------|
| 优先级 | 0 ~ ∞（非负整数） | 数字越小优先级越高；P0 > P1 > P2；相同优先级的通道间按权重随机 |
| 权重 | 0 ~ 1000（非负整数） | 同优先级内权重越大，被选中概率越高；默认 10 |

### 典型用法

- **多站点均衡负载**：所有通道设为同一优先级（如 P0），权重按比例分配
- **公开 Key 优先消耗**：公开 Key 通道 → P0，私有 Key 通道 → P1；P0 全部进入冷却后自动降级到 P1
- **拖拽后修正**：拖拽排序会自动分配递增优先级（P0/P1/P2），可手动改回同一优先级恢复权重随机

### 后端校验

三个通道写入接口统一校验规则：

| 接口 | 校验 |
|------|------|
| `PUT /api/channels/:channelId` | priority/weight 类型检查 + 整数截断 + 范围钳位 |
| `PUT /api/channels/batch` | priority 整数截断（仅处理 priority） |
| `POST /api/routes/:id/channels` | priority/weight 类型安全默认 + 范围钳位 |

### 涉及文件

| 文件 | 说明 |
|------|------|
| `src/server/routes/api/tokens.ts` | 后端校验统一 |
| `src/web/pages/token-routes/ChannelSettingsPanel.tsx` | **新增** 共享配置面板（脏字段跟踪 + prop 同步 + tokenId 0→null 转换） |
| `src/web/pages/token-routes/SortableChannelRow.tsx` | 瘦化重构，改用 ChannelSettingsPanel |
| `src/web/pages/token-routes/types.ts` | Props 类型：`onSaveSettings` 替代 `onTokenDraftChange + onSaveToken` |
| `src/web/pages/token-routes/RouteCard.tsx` | Prop 中转更新 |
| `src/web/pages/TokenRoutes.tsx` | 顶层 `handleChannelSettingsSave` 逻辑 |

## 模型发现优化

自定义镜像对 **Session 连接**（new-api / one-api / sub2api 等 managed-token 平台）的模型发现行为进行了精简：

| 行为 | 官方 | 自定义 |
|------|------|--------|
| 账号级全量模型发现 | ✅ 始终执行（用 session token 查站点所有模型） | ❌ 跳过（这些模型不代表实际可用性） |
| 令牌级模型发现 | ✅ 逐令牌扫描 | ✅ 逐令牌扫描（唯一的发现方式） |
| AccountModelsModal 显示内容 | 站点全量模型列表 | 各令牌实际可用模型的联合 |

**原因**：Session 连接的每个令牌属于不同的分组（group），分组有各自的模型列表和倍率。站点全量模型列表不反映某个令牌实际能用哪些模型，也不反映价格是否合理。

> **注意**：API Key 直连和 OAuth 连接的发现行为不受影响。

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/server/services/modelService.ts` | `refreshModelsForAccount()` 中 `if (!usesManagedTokens)` 包裹账号级发现 |

## 白名单模型自动路由

令牌白名单（`allow-list`）中的模型现在会**直接参与路由重建**，无需依赖上游探测结果（`token_model_availability` 表）。

| 行为 | 官方 | 自定义 |
|------|------|--------|
| 路由通道数据源 | 仅 `token_model_availability`（探测结果） | 探测结果 + 白名单模型 |
| 白名单模型未探测时 | 路由存在但通道为空，需手动添加 | 自动创建通道 |
| 保存白名单后 | 仅过滤现有通道 | 自动重建路由，增减通道 |
| 模型映射保存后 | 触发重建但不含白名单模型 | 白名单模型也参与映射和重建 |

**工作流**：探测获取模型 → 配置白名单精选 → 保存后自动创建路由和通道。

> **注意**：黑名单（`deny-list`）和不过滤（`none`）模式行为不变——仍然依赖探测结果，配合过滤器工作。

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/server/services/modelService.ts` | `rebuildTokenRoutesFromAvailability()` 新增白名单作为第三候选数据源 |
| `src/server/routes/api/stats.ts` | `/api/models/token-candidates` 新增白名单模型到候选列表 |

## API Key 连接探活

自定义镜像在 **API Key 管理** 页面为每个 API Key 连接新增了「探活」按钮，与令牌管理页面的探活功能对齐。

| 页面 | 探活支持 | 探活方式 |
|------|----------|----------|
| API Key 管理 | ✅ 新增 | 站点级探活，自动加载该账号的已发现模型 |
| 账号令牌管理 | ✅ 已有 | 令牌级探活，自动加载令牌白名单模型 |

### 探活模型选择方式改进

原有的探活模型选择为 **纯文本 textarea**（逗号或换行分隔），已改造为 **带搜索框的多选框列表**：

| 改进项 | 说明 |
|--------|------|
| 多选框列表 | 从后端已发现模型自动加载，逐个勾选/取消 |
| 搜索过滤 | 模型数量多时可快速搜索定位 |
| 全选/取消全选 | 一键操作按钮 |
| 智能预选 | 令牌有白名单时预选白名单模型；API Key 连接默认全选已发现模型 |
| 手动补充 | 保留 textarea 作为备选，可手动输入未发现的模型名称，与勾选合并去重 |
| 计数显示 | 按钮显示「开始探活 (N)」，快速确认即将探测的模型数量 |

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/web/components/ModelProbeModal.tsx` | textarea 重构为多选框列表 + 新增 `accountId` prop |
| `src/web/pages/Accounts.tsx` | API Key 行操作新增「探活」按钮（桌面 + 移动端） |

## 探测禁用行为 (probeDisabled)

`probeDisabled` 开关的行为已细化：

| 操作 | 是否被 probeDisabled 阻止 |
|------|--------------------------|
| 自动定时模型发现 | ✅ 阻止 |
| 站点探活 (`/api/sites/:id/probe-models`) | ❌ 放行 |
| 令牌探活 (`/api/account-tokens/:id/probe-models`) | ❌ 放行 |
| **手动刷新模型列表** (`/api/models/check/:accountId`) | ❌ **放行** |

**设计理由**：`probeDisabled` 的初衷是防止自动任务的高频请求触发上游防火墙封 IP。站点/令牌手动探活与手动刷新模型列表都属于用户显式触发的低频操作，应该放行；真正受限的是后台自动模型发现和后台恢复探测。

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/server/services/modelService.ts` | `refreshModelsForAccount()` 新增 `ignoreProbeDisabled` 选项 |
| `src/server/routes/api/stats.ts` | 手动刷新 API 传入 `{ ignoreProbeDisabled: true }` |
| `src/web/pages/Sites.tsx` | 提示文案更新为准确描述新行为 |
