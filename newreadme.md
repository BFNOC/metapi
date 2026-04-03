<div align="center">

<img src="docs/logos/logo-full.png" alt="Metapi" width="280">

**中转站的中转站 — 将分散的 AI 中转站聚合为一个统一网关**

<p>
把你在各处注册的 New API / One API / OneHub / DoneHub / Veloera / AnyRouter / Sub2API 等站点，
<br>
汇聚成 <strong>一个 API Key、一个入口</strong>，自动发现模型、智能路由、成本最优。
</p>

<p align="center">
<img alt="Node.js" src="https://img.shields.io/badge/Node.js-22.15%2B-339933?logo=node.js&style=flat"><!--
--><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&style=flat">
</p>

</div>

---

## 🍴 关于本 Fork

本仓库是 [cita-777/metapi](https://github.com/cita-777/metapi) 的增强版 Fork，包含：

- **自定义功能**：Token 级模型管理、站点模型探测、路由健康度管理等
- **上游新功能**：挑选并合并上游已合并但尚未发版的新 PR

> 📖 详细文档见 [docs/custom/](docs/custom/README.md)

---

## 🎯 自定义功能（本 Fork 独有）

| 特性 | 说明 |
|------|------|
| **Token 级模型管理** | 每个 API Token 可独立配置可用模型列表（白名单/黑名单模式） |
| **站点级模型过滤** | 支持站点维度的模型白名单/黑名单 |
| **模型探活增强** | 批量探测、批次间隔配置、反风控优化（随机真实 prompt）、按探活结果智能排序（异常沉底 + 健康按 TTFT 分档加权） |
| **通道优先级/权重** | 手动配置通道优先级与权重；探活排序自动设置 weight（快 200 / 正常 100 / 慢 30），同 priority 层内按权重概率分流 |
| **路由健康度管理** | 通道级冷却重置、站点惩罚 DB 同步、WebUI 可视化 |
| **登录会话延长** | 会话有效期延长至 30 天 |
| **安全加固** | 剥离上游 IP 泄漏请求头 |

---

## 🚀 上游新功能（已合并尚未发版）

以下功能来自上游已合并的 PR，因作者尚未发版，提前挑选合并：

| PR | 功能 | 说明 |
|----|------|------|
| **#330** | 主动探活 + 负载感知路由 | 四态探测、`stable_first` 主池/观察池、自动恢复探测 |
| **#365** | 路由冷却控制 | 可配置冷却上限、route 级批量清冷却 |
| **#383** | 首字节超时 | 更快甩掉无响应链路，不误伤已输出流 |

---

## 📖 介绍

现在 AI 生态里有越来越多基于 New API / One API 系列的聚合中转站，要管理多个站点的余额、模型列表和 API 密钥，往往既分散又费时。

**Metapi** 作为这些中转站之上的**元聚合层（Meta-Aggregation Layer）**，把多个站点统一到 **一个入口（可按项目配置多个下游 API Key）**——下游所有工具（Cursor、Claude Code、Codex、Open WebUI 等）即可无感接入全部模型。当前已支持以下上游平台：

- [New API](https://github.com/QuantumNous/new-api)
- [One API](https://github.com/songquanpeng/one-api)
- [OneHub](https://github.com/MartialBE/one-hub)
- [DoneHub](https://github.com/deanxv/done-hub)
- [Veloera](https://github.com/Veloera/Veloera)
- [AnyRouter](https://anyrouter.top) — 通用路由平台
- [Sub2API](https://github.com/Wei-Shaw/sub2api) — 订阅制中转

| 痛点                                  | Metapi 怎么解决                                                        |
| ------------------------------------- | ---------------------------------------------------------------------- |
| 🔑 每个站点一个 Key，下游工具配置一堆 | **统一代理入口 + 可选多下游 Key 策略**，模型自动聚合到 `/v1/*` |
| 💸 不知道哪个站点用某个模型最便宜     | **智能路由** 自动按成本、余额、使用率选最优通道                  |
| 🔄 某个站点挂了，手动切换好麻烦       | **自动故障转移**，一个通道失败自动冷却并切到下一个               |
| 📊 余额分散在各处，不知道还剩多少     | **集中看板** 一目了然，余额不足自动告警                          |
| ✅ 每天得去各站签到领额度             | **自动签到** 定时执行，奖励自动追踪                              |
| 🤷 不知道哪个站有什么模型             | **自动模型发现**，上游新增模型零配置出现在你的模型列表里         |

---

## ✨ 核心功能

### 🌐 统一代理网关

- 兼容 **OpenAI** 与 **Claude** 下游格式，对接所有主流客户端
- 支持 Responses / Chat Completions / Messages / Completions（Legacy）/ Embeddings / Images / Models，以及标准 `/v1/files` 文件接口
- 完整的 SSE 流式传输支持，自动格式转换（OpenAI ⇄ Claude）

### 🧠 智能路由引擎

- 自动发现所有上游站点的可用模型，**零配置**生成路由表
- 四级成本信号：**实测成本 → 账号配置成本 → 目录参考价 → 默认兜底**
- 多通道概率分摊，基于成本（40%）、余额（30%）、使用率（30%）加权分配
- 失败通道自动冷却与避让（可配置冷却上限）
- 请求失败自动重试，自动切换其他可用通道
- 路由决策可视化解释，每次选择透明可审计

### 📡 多平台聚合管理

| 平台                | 适配器        | 说明                 |
| ------------------- | ------------- | -------------------- |
| **New API**   | `new-api`   | 新一代大模型网关     |
| **One API**   | `one-api`   | 经典 OpenAI 接口聚合 |
| **OneHub**    | `onehub`    | One API 增强分支     |
| **DoneHub**   | `done-hub`  | OneHub 增强分支      |
| **Veloera**   | `veloera`   | API 网关平台         |
| **AnyRouter** | `anyrouter` | 通用路由平台         |
| **Sub2API**   | `sub2api`   | 订阅制中转平台       |

### 👥 账号与 Token 管理

- **多站点多账号**：每个站点可添加多个账号，每个账号可持有多个 API Token
- **健康状态追踪**：`healthy` / `unhealthy` / `degraded` / `disabled` 四级状态机
- **凭证加密存储**：所有敏感凭证均加密保存在本地数据库中
- **自动续签**：Token 过期时自动重新登录获取新凭证
- **站点联动**：禁用站点自动级联禁用所有关联账号

### 🏪 模型广场

- 跨站点模型覆盖总览：哪些模型可用、多少账号覆盖、各站定价对比
- 延迟、成功率等实测指标展示
- 上游模型目录缓存与品牌分类（OpenAI、Anthropic、Google、DeepSeek 等）
- 交互式模型测试器，在线验证模型可用性

### ✅ 自动签到

- Cron 定时执行（默认每日 08:00）
- 智能解析奖励金额，签到失败自动通知
- 按账号启用/禁用控制
- 完整签到日志与历史查询

### 💰 余额管理

- 定时余额刷新（默认每小时），批量更新所有活跃账号
- 收入追踪：每日/累计收入与消费趋势分析
- 余额兜底估算：API 不可用时通过代理日志推算余额变动

### 🔔 告警通知

支持五种通知渠道：

| 渠道                   | 说明              |
| ---------------------- | ----------------- |
| **Webhook**      | 自定义 HTTP 推送  |
| **Bark**         | iOS 推送通知      |
| **Server酱**     | 微信通知          |
| **Telegram Bot** | Telegram 消息通知 |
| **SMTP 邮件**    | 标准邮件通知      |

### 📊 数据看板

- 站点余额饼图、每日消费趋势图
- 全局搜索（站点、账号、模型）
- 系统事件日志、代理请求日志

### 🎮 模型操练场

- 交互式聊天测试，即时验证模型可用性与响应质量
- 选择任意路由模型，对比不同通道输出
- 流式 / 非流式双模式测试

### 📦 轻量部署

- **单 Docker 容器**，默认本地数据目录部署，支持外接 MySQL / PostgreSQL
- Docker 镜像支持 `amd64`、`arm64` 和 `armv7l` 服务端部署
- 数据完整导入导出，迁移无忧

---

## 🚀 快速开始

### Docker Compose（推荐）

```bash
mkdir metapi && cd metapi

cat > docker-compose.yml << 'EOF'
services:
  metapi:
    image: 1467078763/metapi:latest
    ports:
      - "4000:4000"
    volumes:
      - ./data:/app/data
    environment:
      AUTH_TOKEN: ${AUTH_TOKEN:?AUTH_TOKEN is required}
      PROXY_TOKEN: ${PROXY_TOKEN:?PROXY_TOKEN is required}
      CHECKIN_CRON: "0 8 * * *"
      BALANCE_REFRESH_CRON: "0 * * * *"
      PORT: ${PORT:-4000}
      DATA_DIR: /app/data
      TZ: ${TZ:-Asia/Shanghai}
    restart: unless-stopped
EOF

# 设置 Token 并启动
export AUTH_TOKEN=your-admin-token
export PROXY_TOKEN=your-proxy-sk-token
docker compose up -d
```

<details>
<summary><strong>一行 Docker 命令</strong></summary>

```bash
docker run -d --name metapi \
  -p 4000:4000 \
  -e AUTH_TOKEN=your-admin-token \
  -e PROXY_TOKEN=your-proxy-sk-token \
  -e TZ=Asia/Shanghai \
  -v ./data:/app/data \
  --restart unless-stopped \
  1467078763/metapi:latest
```

</details>

启动后访问 `http://localhost:4000`，用 `AUTH_TOKEN` 登录即可。

---

## 🏗️ 技术栈

| 层                   | 技术                                                              |
| -------------------- | ----------------------------------------------------------------- |
| **后端框架**   | [Fastify](https://fastify.dev) — 高性能 Node.js 后端框架            |
| **前端框架**   | [React 18](https://react.dev) + [Vite](https://vitejs.dev)              |
| **语言**       | [TypeScript](https://www.typescriptlang.org) — 端到端类型安全       |
| **样式**       | [Tailwind CSS v4](https://tailwindcss.com) — 原子化样式框架         |
| **数据库**     | SQLite / MySQL / PostgreSQL +[Drizzle ORM](https://orm.drizzle.team) |
| **数据可视化** | [VChart](https://visactor.io/vchart) (@visactor/react-vchart)        |
| **定时任务**   | [node-cron](https://github.com/node-cron/node-cron)                  |
| **容器化**     | Docker (Debian slim) + Docker Compose                             |
| **测试**       | [Vitest](https://vitest.dev)                                         |

---

## 🛠️ 本地开发

```bash
# 安装依赖
npm install

# 数据库迁移
npm run db:migrate

# 启动开发环境（前后端热更新）
npm run dev
```

```bash
npm run build          # 构建前端 + 后端
npm run build:web      # 仅构建前端（Vite）
npm run build:server   # 仅构建后端（TypeScript）
npm test               # 运行全部测试
npm run test:watch     # 监听模式
npm run db:generate    # 生成 Drizzle 迁移文件
```

---

## 📚 自定义文档

本 Fork 的详细修改文档位于 `docs/custom/` 目录：

| 文档 | 说明 |
|------|------|
| [README.md](docs/custom/README.md) | 自定义文档索引 |
| [schema-changes.md](docs/custom/schema-changes.md) | 数据库 Schema 变更记录 |
| [feature-token-model-management.md](docs/custom/feature-token-model-management.md) | Token 级模型管理功能 |
| [deployment-notes.md](docs/custom/deployment-notes.md) | 部署注意事项 |
| [upstream-sync-log.md](docs/custom/upstream-sync-log.md) | 上游同步记录 |
| [fork-survey.md](docs/custom/fork-survey.md) | Fork 生态扫描报告 |
| [protocol-affinity-tracking.md](docs/custom/protocol-affinity-tracking.md) | 协议亲和性追踪设计 |

---

## 🔗 相关项目

### 上游兼容平台

| 项目                                            | 说明                                    |
| ----------------------------------------------- | --------------------------------------- |
| [New API](https://github.com/QuantumNous/new-api)  | 新一代大模型网关，Metapi 的主要上游之一 |
| [One API](https://github.com/songquanpeng/one-api) | 经典 OpenAI 接口聚合管理                |
| [OneHub](https://github.com/MartialBE/one-hub)     | One API 增强分支                        |
| [DoneHub](https://github.com/deanxv/done-hub)      | OneHub 增强分支                         |
| [Veloera](https://github.com/Veloera/Veloera)      | API 网关平台                            |

### 参考和使用的项目

| 项目                                                 | 说明                                                      |
| ---------------------------------------------------- | --------------------------------------------------------- |
| [All API Hub](https://github.com/qixing-jk/all-api-hub) | 浏览器扩展版 — 一站式管理中转站账号，Metapi 最初灵感来源 |
| [LLM Metadata](https://github.com/nicepkg/llm-metadata) | LLM 模型元数据库，用于模型描述参考                        |
| [New API](https://github.com/QuantumNous/new-api)       | 平台适配器参考实现                                        |

---

## 🔒 数据与隐私

Metapi 完全自托管，所有数据（账号、令牌、路由、日志）均存储在你自己的部署环境中，不会向任何第三方发送数据。代理请求仅在你的服务器与上游站点之间直连传输。

---

## 📜 License

[MIT](LICENSE)

---

<div align="center">

**⭐ 如果 Metapi 对你有帮助，给个 Star 就是最大的支持！**

</div>
