# 协议亲和性追踪与智能路由计划

> 更新时间：2026-04-02
>
> 目标：为每个公益站的每个模型建立“实际上游协议可用性”记录，让 metapi
> 在发起请求前就尽量避开已知不可用协议；如果发生同通道内的协议降级并最终
> 成功，这次交互在 metapi 统计口径上应算作成功，而不是失败。

---

## 1. 背景

当前同一模型可能挂在 30+ 公益站上，但它们支持的上游协议并不一致：

- 只支持 OpenAI Chat Completions
- 只支持 OpenAI Responses
- 只支持 Anthropic Messages
- 声称是 OpenAI 兼容，但某些模型只在部分协议上可用

现在的 metapi 已经具备“协议 fallback”能力，但还没有把这件事彻底做成
“可学习、可复用、可统计”的系统能力。

以你截图中的 OAI-Free 为例：

1. 下游以 `/v1/responses` 发起请求
2. metapi 先试上游 `responses`
3. 上游返回 `502 Bad Gateway`
4. metapi 再降级到 `chat`，最终成功

这条链路对终端用户来说已经“能用”，但仍然存在三个问题：

- 首次多打一枪，平白增加 500ms+ 延迟
- `proxy_logs` 里会先落一条失败，再落一条成功，错误率被放大
- 重启后学习结果丢失，要重新踩坑

---

## 2. 代码现状校验

这部分基于当前仓库代码，而不是旧草案推断。

### 2.1 入口与执行链

当前协议路由的真实链路是：

```text
/v1/responses
  -> openAiResponsesSurface.ts
     -> resolveUpstreamEndpointCandidates()
     -> executeEndpointFlow()

/v1/chat/completions 或 /v1/messages
  -> chatSurface.ts
     -> resolveUpstreamEndpointCandidates()
     -> executeEndpointFlow()
```

也就是说，这不是单纯的 responses 专属逻辑，`chatSurface` 也走同一套候选端点
解析和执行器。

### 2.2 当前已经有的“学习”机制

`upstreamEndpoint.ts` 里已经有一套纯内存学习：

- 维度不是简单的 `site + model`
- 实际 key 为：
  `siteId + downstreamFormat + normalizedModelKey + capability flags`
- capability flags 还会区分：
  - 是否带非图片文件
  - 是否带 remote document URL
  - 是否要求 native responses reasoning

这点很重要：后续做持久化时，不能把现有能力维度拍扁成只有
`site_id + model_key`，否则会把“普通文本请求”和“文件/推理请求”的协议行为混在一起。

### 2.3 当前候选协议不是只靠静态顺序

`resolveUpstreamEndpointCandidates()` 当前会综合这些因素：

1. 平台静态优先级
2. Claude 模型特殊顺序
3. 文件能力排序
4. `fetchModelPricingCatalog()` 取回来的 `supportedEndpointTypes`
5. 运行时内存偏好/阻断

因此，“协议亲和性”不能粗暴地插在最前面直接改写全部顺序，否则会把已有的
文件能力约束、平台约束、目录元数据提示覆盖掉。

### 2.4 当前失败统计的真实归因

旧草案里“降级请求仍计为错误”这个判断方向对，但要说清楚是哪一层的错误：

- `onDowngrade` 目前会调用 `failureToolkit.log(...)`
- 这会写一条 `proxy_logs.status = 'failed'`
- 但这一步**不会**调用 `tokenRouter.recordFailure(...)`

所以现在的现象是：

- 通道健康分不一定被打坏
- 但代理日志统计会多出一条失败

也就是说，真正被污染的是 `proxy_logs` 口径，而不是所有路由健康状态。

### 2.5 当前 `retryCount` 不是“协议降级次数”

`retryCount` 代表的是“通道级重试次数”，不是 `responses -> chat -> messages`
这种同通道内部的协议切换次数。

因此旧草案里的这类判断不够准确：

```ts
endpointResult.ok === true && retryCount === 0
```

它不能可靠区分：

- 同一个 channel 内发生了协议降级但最终成功
- 完全没有发生协议降级，第一次就成功

如果要准确统计“降级成功”，需要 `executeEndpointFlow()` 返回更完整的尝试轨迹。

---

## 3. 旧草案需要补足的关键点

下面这些是旧文档没写透、但后续执行时一定会撞到的点。

### 3.1 不能继续把 owner 逻辑塞进 `routes/proxy`

仓库根 `AGENTS.md` 明确要求：

- `src/server/routes/**` 是适配层，不是 owner
- 被多个模块复用的逻辑不应继续沉在 `src/server/routes/proxy/`

但当前 `upstreamEndpoint.ts` 已经被 `openAiResponsesSurface.ts` 和 `chatSurface.ts`
直接依赖。后续如果继续把“亲和性持久化、统计、判定策略”都往这个文件里堆，
会进一步加深边界债务。

结论：

- 协议亲和性的新 owner 应提取到中性位置
- 建议新建：
  - `src/server/services/endpointAffinityService.ts`
  - `src/server/services/endpointAffinityRuntime.ts`
- `upstreamEndpoint.ts` 只保留请求构建与候选拼装适配

### 3.2 需要先补“尝试轨迹”，再谈日志改口径

现有 `executeEndpointFlow()` 返回值只有：

- `ok`
- `upstream`
- `upstreamPath`
- 或最终失败的 status / errText

它没有返回：

- 每次尝试过哪些 endpoint
- 哪个 endpoint 失败后触发 downgrade
- 最终成功的是哪个 endpoint

没有这些信息，就没法在 surface 层准确做到：

- 最终成功时只记一条 success
- 同时还能知道它是“降级成功”
- 失败时再决定是否补落中间尝试轨迹

因此，执行顺序上必须先做一个小型执行器改造。

### 3.3 持久化表设计不能丢掉能力维度

旧草案里 `endpoint_affinity` 只按：

- `site_id`
- `model_key`
- `endpoint`

建唯一键。

这对“纯文本请求”可能够用，但会和当前运行时 key 不一致。最起码要明确：

- v1 是否只覆盖“纯文本/无附件/无 reasoning continuity”请求
- 如果是，就要在表结构里显式标注 scope
- 如果不是，就必须把 capability bucket 设计进去

推荐做法：

- v1 持久化只覆盖“可协议互换”的文本请求
- 表里增加 `request_scope`，例如：
  - `text_default`
  - `text_reasoning`
- 文件类请求先继续只走现有能力排序，不落亲和性持久化

这样既和当前实现对齐，也能控制复杂度。

### 3.4 不要一开始就为日志统计引入重 schema 负担

当前 `proxy_logs` 已有：

- `status`
- `httpStatus`
- `retryCount`
- `billingDetails`
- client 相关字段

但是没有：

- `downgraded`
- `terminal_endpoint`
- `attempted_endpoints`

如果第一步就改 `proxy_logs` 表，会触发整套 schema 生成与兼容链，成本较高。

而你的核心目标其实是两件事：

1. 降低错误率
2. 降级成功时按 success 计

这两点在 v1 不一定需要先加新列。更实用的顺序应该是：

- 先停止在 `onDowngrade` 直接落 `failed` 日志
- 最终只落一条 success / failed
- 如果需要保留轨迹，先放到内存 trace 或 debug 日志
- 等确认要在 UI 上做降级分析时，再决定是否给 `proxy_logs` 增字段

### 3.5 需要显式定义“观测优先级”

当前系统里已经同时存在三类“协议支持信息”：

1. 平台静态规则
2. 模型目录里的 `supportedEndpointTypes`
3. 运行时观测结果

旧草案没有定义三者冲突时谁优先。建议统一为：

1. **硬约束优先**
   - 文件能力、平台硬限制、Claude/Gemini 特殊限制
2. **显式目录提示作为首选尝试提示**
   - 只影响 first attempt，不直接删掉 fallback
3. **运行时/持久化 blocked 作为“排除条件”**
   - 明确阻断时从候选中移除
4. **运行时/持久化 preferred 作为“重排条件”**
   - 只提升优先级，不凭空新增 endpoint

这样才不会因为某次观测把原本必须保留的 fallback 链截断。

---

## 4. 推荐目标设计

### 4.1 分层模型

协议亲和性建议拆成三层：

#### A. 声明层

来源：

- `preferredEndpointOrder()`
- `rankConversationFileEndpoints()`
- `supportedEndpointTypes`

作用：

- 给出理论候选集和默认顺序

#### B. 热学习层

来源：

- 进程内 `EndpointRuntimeState`

作用：

- 快速吸收最近请求结果
- 低延迟生效
- 适合作为当前进程的第一手观测缓存

#### C. 持久化层

来源：

- DB 中的 endpoint affinity 记录

作用：

- 跨重启保留观测
- 支持后台清理、人工重置、UI 展示

### 4.2 候选排序总流程

建议后续统一成下面这个顺序：

```text
平台/能力硬约束
  -> 目录元数据 first-attempt hint
  -> 持久化 blocked 过滤
  -> 运行时 blocked 过滤
  -> 持久化 preferred 提升
  -> 运行时 preferred 提升
  -> 保留剩余 fallback 顺序
```

说明：

- “过滤”只能删已有候选，不能新增候选
- “preferred”只能改顺序，不能覆盖硬约束
- 运行时层优先于持久化层，因为它更新鲜

### 4.3 降级成功的统计语义

用户视角真正需要的是：

- 最终成功了，就算 success
- 中间只是换了兼容协议，不应记成 failed

因此建议定义如下语义：

- `executeEndpointFlow()` 内部可以发生多次 endpoint attempt
- 但 `proxy_logs` 默认只记录**最终结果**
- 如果最终成功：
  - 落一条 `status = success`
  - 可选附带 `protocolFallback.used = true`
- 如果最终失败：
  - 落一条 `status = failed`
  - 可选附带 `attemptedEndpoints`

### 4.4 502 学习策略

对于你提到的 `Cloudflare 502 / Bad Gateway`，建议不要做“一次即封”。

推荐阈值：

- `404 / 405 / 415 / 501 / dispatch-denied / unsupported endpoint`
  - 立即阻断
- `502 + 明确 bad gateway/cloudflare 文案`
  - 连续 2 次或 3 次后阻断
- `500 / 503 / 504 / 429`
  - 默认不阻断，只保留观测计数

同时补上“成功清零”：

- 同 endpoint 一次成功后，清除该 endpoint 的连续失败计数

---

## 5. 实施分阶段计划

这里把旧草案改成更贴近当前仓库的四阶段。

### 阶段 0：先补边界和轨迹

目标：

- 不改业务语义，先把后续功能需要的执行轨迹补出来

建议改动：

- 提取协议亲和性 owner
  - `src/server/services/endpointAffinityRuntime.ts`
  - `src/server/services/endpointAffinityService.ts` 先留空壳或接口
- 扩展 `executeEndpointFlow()` 返回结构，新增：
  - `successfulEndpoint`
  - `attempts`
  - `downgraded`
  - `downgradedFrom?`

文件：

- `src/server/routes/proxy/endpointFlow.ts`
- `src/server/routes/proxy/endpointFlow.test.ts`
- `src/server/routes/proxy/upstreamEndpoint.ts`
- `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
- `src/server/proxy-core/surfaces/chatSurface.ts`
- `src/server/services/endpointAffinityRuntime.ts`（新）

验收标准：

- 不改变当前 fallback 行为
- surface 层拿得到完整 endpoint trace

### 阶段 1：增强纯内存学习并修正日志口径

目标：

- 先在不引入 DB 变更的前提下，立刻降低无意义错误率

建议改动：

1. 扩展 `shouldBlockEndpointByError()`
   - 加入 502 分类，但必须配连续次数阈值

2. 扩展运行时 state
   - 增加 `failureCountByEndpoint`
   - 可选增加 `lastFailureAtMsByEndpoint`

3. 放宽成功记忆
   - 对 `downstreamFormat = responses` 且最终成功走 `chat/messages`
     的情况允许记忆
   - 但仍只限“可协议互换”的文本请求

4. 调整日志写法
   - 删除 `onDowngrade -> failureToolkit.log('failed')` 这一直接落库路径
   - 改为由 surface 在拿到 `endpointResult` 之后统一决定写一条最终日志

5. 统计口径
   - 降级成功：`proxy_logs` 只记 success
   - 仅当全部候选都失败时才记 failed

文件：

- `src/server/services/endpointAffinityRuntime.ts`
- `src/server/routes/proxy/endpointFlow.ts`
- `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
- `src/server/proxy-core/surfaces/chatSurface.ts`
- `src/server/proxy-core/surfaces/sharedSurface.ts`
- `src/server/routes/proxy/upstreamEndpoint.test.ts`
- `src/server/routes/proxy/endpointFlow.test.ts`

预期收益：

- 对“responses 总是 502、chat 稳定可用”的站点，第二次起直接走可用协议
- `proxy_logs` 错误率显著下降

### 阶段 2：持久化协议亲和性

目标：

- 进程重启后保留学习结果
- 为后续运营/手动重置提供基础

表设计建议：

```sql
CREATE TABLE endpoint_affinity (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id         INTEGER NOT NULL,
  model_key       TEXT NOT NULL,
  request_scope   TEXT NOT NULL DEFAULT 'text_default',
  endpoint        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'unknown',
  failure_count   INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_failure_at TEXT,
  blocked_until   TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(site_id, model_key, request_scope, endpoint)
);
```

`request_scope` 的第一版建议只支持：

- `text_default`
- `text_reasoning`

暂不覆盖：

- 图片
- 音频
- 非图片文件
- remote document URL

写入策略建议：

- 热路径先更新 runtime memory
- DB 写入使用 best-effort / fire-and-forget
- 读取时：
  - 先查 runtime
  - 再查持久化

插入顺序建议：

- 先经过平台/能力/catelog 约束生成候选
- 再应用持久化 affinity
- 最后再应用运行时 affinity

涉及文件：

- `src/server/services/endpointAffinityService.ts`（新）
- `src/server/services/endpointAffinityService.test.ts`（新）
- `src/server/db/schema.ts`
- `src/server/db/generated/schemaContract.json`
- `src/server/db/generated/mysql.bootstrap.sql`
- `src/server/db/generated/mysql.upgrade.sql`
- `src/server/db/generated/postgres.bootstrap.sql`
- `src/server/db/generated/postgres.upgrade.sql`
- `src/server/services/databaseMigrationService.test.ts`

### 阶段 3：可观测性与运维控制

目标：

- 能看见哪些站点/模型被学成了什么协议
- 能手动重置错误学习

这里建议优先“复用已有 API 面”而不是直接加一套全新页面。

优先级顺序：

1. 先补 API
   - `GET /api/endpoint-affinity?siteId=...`
   - `POST /api/endpoint-affinity/reset`

2. 再决定挂到哪里展示
   - 站点详情
   - 通道详情
   - 现有 stats 页面

3. 若确实需要统计“降级成功率”
   - 再评估是否给 `proxy_logs` 单独加列
   - 或先用 `billingDetails` / 单独 summary API 输出

不建议在阶段 1 就直接给 `proxy_logs` 加 `downgraded` 字段。

---

## 6. 数据与日志设计建议

### 6.1 `proxy_logs` 的 v1 方案

v1 不强依赖改表，建议只改写入时机：

- 中间 downgrade attempt 不写 failed
- 最终成功写 success
- 最终失败写 failed

如果需要保留“这次其实发生了降级”，可用两种方式二选一：

#### 方案 A：临时放进 `billingDetails`

优点：

- 不需要立刻改 schema

缺点：

- 不利于 SQL 直接聚合

#### 方案 B：新建独立 attempt telemetry

例如单独的 debug 事件表或内存 ring buffer。

优点：

- 不污染主 `proxy_logs`

缺点：

- 额外实现成本

结论：

- 阶段 1 用 A 或纯内存 trace
- 等阶段 3 确认 UI 需求再决定是否升级为结构化列

### 6.2 channel 健康统计口径

继续保持现有语义更合理：

- 同一 channel 内部的协议降级成功
  - 不算 channel failure
- 全部 endpoint 都失败
  - 才算 channel failure

也就是说，这次改动主要修的是 `proxy_logs` 和 endpoint affinity，
不是去推翻 `tokenRouter` 的健康评分逻辑。

---

## 7. 测试与验证计划

### 7.1 单元测试

需要补的测试族：

- `src/server/routes/proxy/upstreamEndpoint.test.ts`
- `src/server/routes/proxy/endpointFlow.test.ts`
- `src/server/services/endpointAffinityService.test.ts`（阶段 2）

建议新增用例：

- repeated 502 达阈值后阻断指定 endpoint
- 单次 502 不阻断
- success 后清空 endpoint failure count
- responses 下游在 chat 成功后可记忆 preferred endpoint
- affinity 只作用于 `text_default`，不污染文件类请求
- `executeEndpointFlow()` 返回 attempts / downgraded trace

### 7.2 集成测试

优先复用现有协议测试族，而不是新造一套框架：

- `chat.stream.test.ts`
- 与 responses surface 相关的兼容测试

目标场景：

1. 上游 `responses` 返回 502
2. 上游 `chat` 返回 200
3. 首次请求成功，且只落最终 success
4. 第二次请求直接从 `chat` 开始

### 7.3 数据库验证

如果进入阶段 2，按仓库规则必须一起做：

1. 更新 `src/server/db/schema.ts`
2. 重新生成 schema artifacts
3. 跑 schema 相关测试

建议命令：

```bash
npm run schema:generate
npm run test:schema:unit
npm run repo:drift-check
```

注意：

- 不要手写 MySQL/Postgres 新补丁
- 让 schema contract 驱动生成结果

---

## 8. 风险评估

### 风险 1：把瞬时 502 学成长期阻断

等级：中

缓解：

- 连续失败阈值
- 更短 TTL
- 成功即清零
- 提供手动 reset

### 风险 2：把文本请求的学习误用于文件/推理请求

等级：高

缓解：

- 持续保留 capability bucket
- v1 持久化只覆盖文本请求

### 风险 3：为了统计“降级成功”过早改重 schema

等级：中

缓解：

- 先改最终日志落点
- 延后 `proxy_logs` 结构化字段

### 风险 4：继续把 owner 逻辑堆进 `routes/proxy`

等级：中

缓解：

- 阶段 0 先抽离 affinity owner

---

## 9. 推荐执行顺序

如果下一次要真正开工，建议按下面顺序做，而不是直接从建表开始：

1. 先补 `executeEndpointFlow()` trace 返回结构
2. 去掉 `onDowngrade` 直接写 failed log
3. 增强内存学习：502 连续计数 + fallback success 记忆
4. 用真实站点验证“错误率下降、延迟下降”
5. 再决定是否上持久化表
6. 最后再决定 UI 和日志细粒度字段

这个顺序能最快把你最关心的收益拿到手：

- 更少的 502
- 更低的平均延迟
- 降级成功按 success 计

---

## 10. 本次相对旧草案新增的补充结论

这次补文档，重点新增了以下几个旧稿里缺失的结论：

- 这不是只改 `/v1/responses`，`chatSurface` 也在同一条链路上
- 当前被污染的主要是 `proxy_logs` 统计，不是所有 channel 健康评分
- `retryCount` 不是协议降级次数，不能拿来判定 downgrade success
- 必须先扩展 `executeEndpointFlow()` 的 attempts trace
- 持久化不能简单按 `site + model + endpoint` 粗暴建模
- 仓库边界要求不要继续加深 `routes/proxy` owner 逻辑
- DB 变更必须走 schema contract / generated artifacts / drift-check 全链路

这几个点补齐后，这份计划就能真正拿去执行，而不是只停留在“方向正确”。

----

## 补充说明（基于当前代码进一步核对）

### 1. `supportedEndpointTypes` 目前只能当“首跳提示”，不能直接当真值

当前 `resolveUpstreamEndpointCandidates()` 对模型目录里的
`supportedEndpointTypes` 处理方式是：

- 如果目录里能看出明确 endpoint
- 只把它用于选择第一个尝试的协议
- 不会直接砍掉后续 fallback

这说明目录元数据在当前仓库里的设计定位本来就是“提示”而不是“裁决”。

因此后续做协议亲和性时，建议保持下面这个优先级：

1. 目录元数据只负责 first attempt hint
2. 运行时/持久化 affinity 才负责 blocked / preferred
3. fallback 链默认保留，除非被明确阻断

这样更符合当前实现，也更稳。

### 2. `onDowngrade` 现在是“提前落失败日志”，不是“最终失败后再记录”

当前 surface 层的问题不是“最后失败时写错了”，而是：

- `executeEndpointFlow()` 每当判断应该 downgrade
- 就立刻调用 `onDowngrade`
- `onDowngrade` 现在直接写一条 `status = failed`

所以真正的改法不是简单把某个 `failed` 改成 `success`，而是：

- 不要在 `onDowngrade` 直接写入最终统计日志
- 让 `executeEndpointFlow()` 先把 attempts trace 返回给 surface
- 再由 surface 依据最终结果决定记一条 success 还是 failed

这一步如果不先做，后面再加 affinity 也只能降低失败次数，不能彻底修正统计口径。

### 3. Phase 1 最好不要同时改 `proxy_logs` 表结构

当前 `sharedSurface.ts` 写日志是统一入口，`proxy_logs` 已经承担很多统计职责。

如果第一阶段同时引入：

- `downgraded`
- `terminal_endpoint`
- `attempted_endpoints`

就会把“降低错误率”这个本来可以很快落地的目标，拖进 schema 变更链里。

更稳妥的做法是：

- Phase 1 只改日志写入时机和最终统计口径
- Phase 2 再决定是否为运维分析补结构化字段

这样能更快拿到收益，也能减少一次改动面。

### 4. 如果进入 DB 持久化，必须按本仓库的 schema 流程一起做

这个仓库不是只改一个 `schema.ts` 就结束。只要加新表或新列，至少要一起处理：

- `src/server/db/schema.ts`
- `src/server/db/generated/schemaContract.json`
- `src/server/db/generated/mysql.bootstrap.sql`
- `src/server/db/generated/mysql.upgrade.sql`
- `src/server/db/generated/postgres.bootstrap.sql`
- `src/server/db/generated/postgres.upgrade.sql`
- 相关 schema / migration tests

建议在计划执行时把下面这些命令直接列入验证清单：

```bash
npm run schema:generate
npm run test:schema:unit
npm run repo:drift-check
```

否则很容易出现“SQLite 本地能跑，但 schema artifacts 漏更新”的后遗症。

### 5. 协议亲和性 owner 最好独立出来，不要继续加深 `upstreamEndpoint.ts`

虽然当前运行时学习逻辑还在 `upstreamEndpoint.ts`，但按仓库边界要求，
后续新增功能最好不要继续把状态管理和持久化逻辑压进去。

建议的最小拆分方式：

- `upstreamEndpoint.ts`
  - 保留候选集拼装
  - 保留上游请求构建
- `endpointAffinityRuntime.ts`
  - 管内存状态
  - 管 502 连续失败计数
  - 管 preferred / blocked 判定
- `endpointAffinityService.ts`
  - 管 DB 持久化
  - 管 reset / query / merge

这样后面无论加 API、加 UI，还是做后台清理，都不会继续把 `routes/proxy`
变成 owner。

---

## 11. 最终判定规则（硬约束）

> **此节为所有阶段的实现者必须遵守的硬规则。**
> 无论内部实现如何演进，最终对外行为必须符合以下 4 条。

对 `site + model + request_scope` 的每一次请求：

1. **任一候选协议成功 = 请求成功**
   - 只要本次请求在 `responses` / `chat` / `messages` 中任一候选协议上最终成功，整次请求**必须**记为 `success`
   - 不允许因为中间某个协议失败就记为 `failed`

2. **中间协议失败只是 attempt，不是 failure**
   - 中途某个协议失败但后续协议成功，该中途失败只能算 `attempt`（尝试），不能记为 `failed`
   - `proxy_logs` 对该次请求只落一条最终结果日志

3. **全部可用候选协议失败 = 请求失败**
   - 只有当本次请求的**所有可用候选协议**全部尝试后仍然失败，才允许记为 `failed`
   - 此时才触发 `tokenRouter.recordFailure()`

4. **已学习阻断的协议从候选中排除**
   - 若某协议已被 affinity 学习标记为 blocked（被重复降级 N 次），后续请求**不需要再次尝试**该协议
   - 失败判定基于"剩余可用候选协议"是否全部失败，而不是"理论上的三种协议"是否全部失败
   - 被排除的协议不影响成功/失败的判定

### 学习信号定义

学习信号**不绑定特定 HTTP 状态码**（502/400/404 都可能触发降级）：

- **学习信号 = 降级事件**：协议 X 失败触发了 `shouldDowngrade()` 并降级到协议 Y
- **正向学习**：协议 Y 降级后成功 → Y 标记为 `preferred`，X 的降级计数 +1
- **阻断阈值**：同一 `site + model + scope` 下，协议 X 被降级 ≥ N 次（建议 N=2）→ 从候选中移除
- **恢复机制**：
  - 阻断有 TTL（建议 6h），过期后自动恢复候选资格
  - 手动重置可立即清除所有阻断
  - 如果协议 X 在某次请求中直接成功（TTL 过期后的重试），清零降级计数
