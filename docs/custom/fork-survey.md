# Fork 生态扫描报告

> 扫描日期：2026-03-29
> 上游仓库：https://github.com/cita-777/metapi
> 上游 main SHA：`03ca115` (2026-03-28)
> 扫描范围：全部 160+ 个 fork

## 扫描结论

绝大多数 fork 无实质修改（仅 fork 未改动或只有 merge 提交）。以下为有独立提交的 fork。

---

## 值得关注的 Fork

### 1. aimaxccwucc/metapi — 最活跃（+131 commits）

**仓库地址：** https://github.com/aimaxccwucc/metapi

#### 基本信息

| 项目 | 详情 |
|------|------|
| GitHub 创建时间 | 2026-03-04 |
| 实际作者 | tanmw（131 commits），非上游作者 |
| 总提交数 | 305（上游 519） |
| 独立提交 | +131 ahead of upstream |
| 落后上游 | 345 commits behind（截至 2026-03-29） |
| 最后活跃 | 2026-03-27 |
| 最后一次同步上游 | 2026-03-22（`feat: complete upstream clean-port migration batch`） |

#### 仓库特征

- **不是标准 fork 流程**：作者从上游根提交 `2ecc237`（2026-02-27）开始，用 `initialize clean metapi repository` 初始化，然后选择性合并上游提交 + 添加自有功能
- **有 7 个 "Refactor code structure" 提交**：说明作者对上游代码做了重构/重组织
- **提交者分布**：tanmw 131 次, cita(上游) 135 次, Hureru 15 次, ciat-777 13 次, bnvnvnv 5 次 — 包含多个上游贡献者的提交（通过 merge 引入）
- **选择性同步**：不是全量跟上游，而是手动挑选合并，导致落后 345 个提交
- **作者其他项目**：`codex-session-patcher`, `any-auto-register`, `cursor2api`, `ds2api` — AI API 代理/工具方向

#### 借鉴风险评估

| 风险 | 说明 |
|------|------|
| 代码结构差异 | 做过 7 次重构，文件组织可能与上游不同，直接 cherry-pick 可能需要适配 |
| 落后上游较多 | 345 commits behind，部分功能可能基于旧版上游实现 |
| 无测试保障 | 131 个自有提交中测试覆盖未知 |
| 单人开发 | 仅 tanmw 一人，代码质量无第二人审查 |

#### 主要改动分类

最大的第三方 fork，功能覆盖面广。主要改动分为以下几类：

#### 路由与网关加固
- 模型级熔断器（circuit breaker）
- 自适应通道故障转移（adaptive channel failover）
- 网关路由加固（gateway routing hardening）
- 协议感知的上游 fallback
- 路由诊断与无通道代理日志
- 显式路由组源健康检查

#### 安全加固
- IP 级速率限制中间件（`requestRateLimit.ts`）
  - `/api/accounts/login` 5次/分钟
  - `/api/accounts/verify-token` 5次/分钟
  - `/api/settings/auth/change` 3次/分钟
  - `/api/monitor/*` 各有限制
  - `/api/models/token-candidates` 30次/分钟

#### 性能优化
- 懒加载全局 App overlays
- 延迟加载路由候选数据
- Dashboard 分析渐进渲染
- Marketplace 页面渐进渲染
- 空闲时预加载常用路由

#### 运维工具
- 一键生产升级脚本（带备份和回滚）
- 生产回滚工作流
- 金丝雀升级检查

#### Marketplace 增强
- Marketplace 可用性探活
- 探活详情切换
- 诊断复制操作
- 模型按能力探活

#### 其他
- 批量站点操作
- 路由模型选择器优化
- 账户/站点表头排序
- 自动创建缺失路由覆盖的 group token
- URL 路径拼接修复（防止重复 `/v1`）

#### 潜在可借鉴功能
| 优先级 | 功能 | 理由 |
|--------|------|------|
| 高 | 速率限制中间件 | 安全必备，实现相对独立 |
| 高 | 模型级熔断器 | 提升路由稳定性 |
| 中 | 性能优化（懒加载等） | 改善前端体验 |
| 中 | 生产部署/回滚脚本 | 运维便利 |
| 低 | Marketplace 探活增强 | 功能较重，与现有探活可能冲突 |

---

### 2. Babylonehy/metapi — 小幅增强（+8 commits）

**仓库地址：** https://github.com/Babylonehy/metapi

#### 主要改动
- **飞书/Lark webhook 通知** — 通知服务新增飞书支持，含 UI 更新和测试
- **手动模型保留** — 发现刷新时保留手动添加的模型
- **移动端路由批量操作** — 修复移动端路由批量操作布局

#### 潜在可借鉴功能
| 优先级 | 功能 | 理由 |
|--------|------|------|
| 中 | 飞书 webhook 通知 | 国内用户常用 |
| 低 | 手动模型保留 | 需确认是否已有类似逻辑 |

---

### 3. bgzhang1/metapi1 — LLM 模型名归一化（+8 commits）

**仓库地址：** https://github.com/bgzhang1/metapi1

#### 主要改动
- **LLM 模型名称归一化** — 用 AI 模型标准化模型名称，带 regex fallback
- 路由重建时自动归一化模型名
- UI 设置页新增归一化开关和配置

#### 潜在可借鉴功能
| 优先级 | 功能 | 理由 |
|--------|------|------|
| 低 | LLM 模型名归一化 | 思路有趣但增加 LLM 依赖，实用性待评估 |

---

### 4. Shinku-Chen/metapi — 密钥工具（+7 commits）

**仓库地址：** https://github.com/Shinku-Chen/metapi

#### 主要改动
- 随机生成密钥功能
- 密钥复制按钮
- PROXY_TOKEN 随机生成

#### 潜在可借鉴功能
| 优先级 | 功能 | 理由 |
|--------|------|------|
| 低 | 密钥随机生成/复制 | 小功能，实现简单，可自行实现 |

---

## 低价值 Fork（仅记录）

| Fork | 提交数 | 说明 |
|------|--------|------|
| gy19960428/metapi | +1 | 备份导入序列漂移修复 |
| 863401402/metapi | +6 | 1 个 fix（`parseStoredUtcDateTime`）+ 无意义提交 |
| presshot/metapi | +3 | 小改动（日志、时间服务、newApi） |
| vfhky/metapi | +5 | 仅文档改动 |
| dzhantsyan/metapi | +1 | 仅添加 keep.txt |
| ZYQiang/metapi | +2 | GitHub Pages 配置，无代码改动 |

---

## 后续行动建议

### 借鉴策略

**理解思路自己实现 > 直接搬代码**：
- aimaxccwucc 做过代码重构，文件路径/结构与上游（及我们的 fork）不一致
- cherry-pick 大概率不能直接用，需要手动适配
- 更好的方式是：阅读其实现思路，在我们自己的代码结构上重新实现
- 特别是速率限制、熔断器这类通用模式，看懂原理后自己写更可控

### 优先级

1. **速率限制中间件**（安全必备，模式清晰，实现独立）
2. **模型级熔断器**（提升路由稳定性）
3. **性能优化（懒加载/渐进渲染）**（改善前端体验）
4. **生产部署/回滚脚本**（运维便利）

### 注意事项

- **定期复查 aimaxccwucc/metapi**：该 fork 持续活跃，可能有新的可借鉴功能
- **避免大规模合并**：从活跃 fork 借鉴时，以理解 + 重写单个功能为主
- **保持上游兼容**：我们的修改应尽量不改动上游文件结构，以便持续跟随上游更新
