# #383 首字节超时 + 日志 Badges — 合并补充版

> 基线文档：
> `/Users/chaos/.gemini/antigravity/brain/08449911-edee-4a37-a9a1-6fd8539062cc/implementation_plan.md.resolved`
>
> 上游 PR：
> `https://github.com/cita-777/metapi/pull/383`
>
> 校验时间：2026-04-02
>
> 处理方式：不改原文；本文件内容应视为“追加在原文末尾”的合并补充版。
>
> 审计范围：上游 PR 描述、files diff、review comments、当前 `metapi`
> 仓库实现。

---

## 1. 一句话结论

Claude 文档的大方向是对的：

1. `first-byte timeout` 的核心能力值得引入
2. `proxy_logs` 的 `is_stream / first_byte_latency_ms` 也有观测价值

但当前 fork 不适合一次性照搬 upstream 43 个文件。

更合理的做法是分两层：

1. 先合“首字节超时引擎 + surface / endpointFlow 接入 + 可配置开关”
2. 再单独决定是否补“`proxy_logs` schema + API + UI badges”

也就是说，这个 PR **值得吸收，但要拆相位，不要整包照抄**。

---

## 2. 本次补充确认的关键事实

### 2.1 上游 PR 真正解决的问题

上游 PR #383 解决的不是普通请求超时，而是更具体的“上游已经接受请求，但在很长
时间内完全没有返回任何首包 / 首 token”。

这类问题在公益站和兼容站点上很常见，症状通常是：

1. 请求不是立刻失败
2. 也不是持续输出得很慢
3. 而是卡在“没有任何首字节”的空等状态

上游方案的价值在于：

1. 只有在“完全没有首字节”时才触发超时
2. 一旦已经开始输出，流不会被这项超时打断
3. 超时结果会被当成 retryable，允许继续尝试后续 endpoint / channel

这和普通 `request timeout` 的语义不一样，也比“整次请求超时后再失败”更适合
当前项目的代理场景。

### 2.2 当前仓库已经有可承接的 owner

这也是为什么我认为它值得引入。

当前仓库里已经有几条很清晰的 owner 链，不需要为 #383 再新造结构：

1. endpoint fallback 已集中在 `src/server/routes/proxy/endpointFlow.ts`
   - 这里已经负责候选 endpoint 的依次尝试与成功 / 失败返回
   - 是首字节超时最自然的接入点

2. surface 侧的 dispatch 和日志入口已集中在
   `src/server/proxy-core/surfaces/sharedSurface.ts`
   - `createSurfaceDispatchRequest()`
   - `writeSurfaceProxyLog()`
   - `recordSurfaceSuccess()`
   - `createSurfaceFailureToolkit()`

3. `proxy_logs` 的兼容写入链已经成熟
   - `src/server/services/proxyLogStore.ts`
   - `src/server/db/index.ts`
   - `src/server/db/legacySchemaCompat.ts`
   当前已经有：
   - billing details
   - downstream api key id
   - client fields
   这说明后续如果真要加新列，项目已经有现成模式。

4. 路由类 runtime settings 也已经有稳定入口
   - `src/server/config.ts`
   - `src/server/routes/api/settings.ts`
   - `src/web/pages/Settings.tsx`

所以 #383 在当前 fork 里不是“能不能做”的问题，而是“要不要一次做太多”的问题。

### 2.3 当前 fork 和 upstream 的关键差异

Claude 文档里有几处默认前提，放到当前仓库里需要改写。

#### 2.3.1 当前仓库没有 upstream 那套 `siteApiEndpointPool`

上游 #383 的 direct route 部分，很多是围绕：

- `runWithSiteApiEndpointPool(...)`
- `SiteApiEndpointRequestError`

这一层展开的。

当前仓库里没有这套结构，`completions / images / search` 仍然是 route 内直接
`fetch(...)`，所以：

1. direct route 的接入方式不能照搬 upstream 文件改法
2. Claude 文档里的 Phase E 需要改写成“适配当前直连 fetch 结构的版本”

#### 2.3.2 当前运行时 dispatch 还没有 `AbortSignal` 透传

这是 #383 在当前仓库里的一个真实前置。

目前：

- `RuntimeDispatchInput` 还没有 `signal`
- `dispatchRuntimeRequest(...)` 只是把 `input` 分派给各 executor
- `createSurfaceDispatchRequest()` 返回的函数签名也只有
  `(request, targetUrl?)`

如果不先补这一层，`fetchWithObservedFirstByte(...)` 就无法真正中止当前
attempt。

这意味着：

1. Claude 文档的 Phase D / F 是对的
2. 但这里不是“附带优化”，而是首字节超时能否成立的硬前置

#### 2.3.3 当前仓库还没有 `disableCrossProtocolFallback`

上游 review 对 #383 做过一个关键修正：

- 首字节超时快路径也必须尊重 `disableCrossProtocolFallback`

但当前仓库已经没有这个输入项。

所以这里要分开看：

1. upstream 修正本身是正确的
2. 但它不是当前 fork 的直接移植点

更准确的说法应是：

- **当前不用因为这个标志阻塞 #383**
- **但如果以后重新引入该能力，首字节超时快路径也必须同步尊重它**

#### 2.3.4 当前一些 direct route 仍在直接 `.text()`

当前仓库对压缩 / zstd 的兼容，已经通过
`readRuntimeResponseText()` 建了一套统一读取路径。

但 `completions / images / search` 这些 direct route 里，仍然能看到直接
`upstream.text()` 的用法。

如果后续要动这些 route，建议顺手一起纠正：

1. 统一走 `readRuntimeResponseText()`
2. 避免一边引入首字节超时，一边保留旧的全量 body 读取不一致

这点不是 #383 的主目标，但属于“既然碰到就不要再留旧口子”的修正。

---

## 3. 上游 review 里必须继承的实现约束

这一部分 Claude 文档没有明确写出来，但从 upstream review comments 看，
至少有 3 个约束应该保留。

### 3.1 首字节计时必须按“每次 attempt”独立开始

这点非常关键。

如果把 `startedAtMs` 放在整次请求外层，那么：

1. 第一次 endpoint 失败后
2. 第二次 endpoint / 第二个 target 再尝试时
3. 会继承已经流逝掉的时间预算

结果就是：

1. 重试 attempt 会被错误地“缩短可用超时”
2. `firstByteLatencyMs` 也会被算大

所以正确做法应是：

- 每个 attempt 开始前单独记录自己的 `attemptStartedAtMs`
- 只用这个时间去计算该次请求的首字节预算和延迟

### 3.2 新增日志参数不要给默认值掩盖漏改 callsite

upstream review 还指出过一个很实用的问题：

如果你给新增的 `isStream / firstByteLatencyMs` 参数写默认值，那么旧 callsite
就算没改，也会“静默成功”。

结果是：

1. 类型不报错
2. 功能表面能跑
3. 但你以为已经记录了首字节元数据，实际上部分失败分支被悄悄丢掉了

所以一旦进入“日志 schema / 透传元数据”阶段，建议：

1. 新增参数直接改成必传
2. 让漏改 callsite 在编译期暴露出来

### 3.3 如果未来恢复“禁止跨协议 fallback”，超时快路径也必须一起遵守

这条对当前仓库不是 immediate blocker，但它是未来正确性约束。

否则会出现一种很怪的语义偏差：

1. 普通 endpoint failure 会尊重“不允许跨协议回退”
2. 但 first-byte timeout 却悄悄继续掉到下一个协议

这会把配置语义撕裂。

所以这条应该记在补充文档里，避免后面再踩一次 upstream 已经踩过的坑。

### 3.4 实施时还要注意 4 个落地细节

这几条不是方案层结论，但实现时很容易漏。

#### 3.4.1 GeminiSurface 的 dispatch 路径独立于 shared surface

当前仓库里，GeminiSurface 并没有统一走
`createSurfaceDispatchRequest()`。

它至少有两条独立路径：

1. internal gemini
   - 通过 `dispatchRuntimeRequest(...)`
2. 非 internal gemini
   - 在 `dispatchSelectedRequest()` 里直接 `fetch(...)`

这意味着：

1. 就算给 `createSurfaceDispatchRequest()` 补了 `signal`
2. 也不会自动覆盖 GeminiSurface 全部路径

所以 GeminiSurface 必须单独适配首字节超时。

#### 3.4.2 `fetchWithObservedFirstByte()` 的 replay 机制对错误体读取是安全的

`endpointFlow()` 在 dispatch 失败后，会继续读取错误体。

而 `fetchWithObservedFirstByte()` 的实现本身会：

1. 先消费首个 chunk
2. 再通过 replay stream 重建一个新的可读 `Response`

因此后续错误体读取不会天然丢数据。

这里不需要额外做特殊补丁，但测试最好覆盖：

1. 非 2xx response
2. 经过首字节观察
3. 后续仍能完整读 body

#### 3.4.3 `undici` 依赖本身没有兼容障碍

上游 `firstByteTimeout.ts` 直接：

- `import { Headers, Response } from 'undici'`

放到当前仓库里没有额外兼容问题，因为当前项目本来就在大量使用 `undici`。

所以实现成本主要在行为接入，不在依赖兼容。

#### 3.4.4 `signal` 透传应优先做“统一入口”，不是逐 executor 手搓

这里需要对旧判断做一个更准确的修正。

当前仓库虽然有多种 executor：

1. `codex`
2. `claude`
3. `gemini-cli`
4. `antigravity`
5. default fetch

但它们大多最终都会汇到 `performFetch(...)`。

因此更好的第一阶段做法不是“只改 default executor”，而是：

1. 给 `RuntimeDispatchInput` 增 `signal`
2. 在 `performFetch(...)` 统一透传到最终 `fetch(...)`
3. 再单独补那些没有走统一入口的 direct fetch 路径

当前最典型的额外路径就是：

1. GeminiSurface 非 internal 分支
2. direct route 的 `completions / embeddings / images / search`

这样改动更集中，也更不容易漏 executor 分支。

---

## 4. 对 Claude 文档的修正版判断

### 4.1 可以直接保留的部分

下面这些判断基本成立：

1. 新增 `firstByteTimeout.ts`
2. 给 surface / shared 层补 `isStream / firstByteLatencyMs` 透传能力
3. 给 `endpointFlow()` 接入首字节超时语义
4. `proxyRetryPolicy.ts` 增加 `first byte timeout` pattern
5. `settings.ts / Settings.tsx` 这条链可以作为运行时配置入口

### 4.2 需要改写后才成立的部分

#### 4.2.1 Phase B 不能默认和核心超时绑定成一个补丁

Claude 文档把：

1. 首字节超时能力
2. `proxy_logs` 新列
3. badge UI

放在一份大方案里，这在“完整能力图”上没有问题，但不一定适合当前 fork 的首轮
落地。

原因：

当前仓库自己的 `protocol-affinity-tracking.md` 已经明确强调：

1. 阶段 1 不要急着给 `proxy_logs` 加重 schema
2. 先修行为，再决定是否要补结构化统计字段

这条本地约束应该保留。

所以更稳妥的判断应是：

- Phase B 是“第二阶段可选增强”
- 不是 #383 核心超时能力的硬前置

#### 4.2.2 Phase E 必须按当前直连 fetch 结构重写

这部分不能按 upstream 术语直接照抄。

更准确的说法应是：

1. `completions / embeddings / images / search`
   目前仍然是 direct route
2. 如果要让它们也享受首字节超时
   - 需要在各自 route 内包 `fetchWithObservedFirstByte(...)`
   - 需要补 per-attempt `startedAtMs`
   - 需要把读取路径统一成 `readRuntimeResponseText()`
3. 这一相位完全可以后置到 surface 主链稳定以后再做

#### 4.2.3 Phase G 的默认值不建议直接写成 45 秒

这里我不建议直接继承 Claude 文档里的默认值建议。

更稳妥的分层应该是：

1. **代码默认值：`0`**
   - 避免未评估前就改变现有请求语义
   - 也和 upstream 最终实现一致

2. **部署层建议值：`30 ~ 45` 秒**
   - 只在确认公益站链路确实有“长时间无首字节卡死”问题后再打开
   - 可以通过环境变量或 runtime settings 配置

也就是说：

- `45s` 更像运营 / 部署建议
- 不应该先写成仓库层面的硬默认

### 4.3 当前阶段不建议和 #383 混在一起的部分

下面这些不建议和“首字节超时核心行为”绑成同一批改动：

1. 大规模 owner 重构
   - 例如把 `endpointFlow` 一起搬家到新目录
   - 这会把“行为修复”与“架构迁移”混成一批

2. 一上来就把 `proxy_logs` 相关 drizzle 产物全量 churn
   - 如果阶段 1 不上 schema，那这些 generated artifacts 也不必先改

3. direct route 的大面积结构改造
   - 先把 surface 主链打通更稳
   - direct route 后补即可

---

## 5. 面向当前 fork 的推荐实施顺序

这里给一份比 Claude 文档更适合当前仓库的分期顺序。

### Phase 1：首字节超时核心能力，先不改 `proxy_logs` schema

目标：

- 先把“卡在没有任何首字节的上游”判成 retryable
- 优先覆盖现有 surface 主链
- 不把首轮 patch 扩成 schema + UI 大补丁

范围建议：

1. 新增 `src/server/proxy-core/firstByteTimeout.ts`
2. 新增对应单测
3. 给 `RuntimeDispatchInput` 增 `signal?: AbortSignal`
4. 让 `dispatchRuntimeRequest()` 和各 executor 无损透传 `signal`
5. 扩展 `createSurfaceDispatchRequest()` 支持 `signal`
6. 在 `executeEndpointFlow()` 中接入 `fetchWithObservedFirstByte(...)`
7. 在 `chatSurface / openAiResponsesSurface / geminiSurface` 接入首字节超时
8. `proxyRetryPolicy.ts` 增加 `first byte timeout` pattern

这一阶段的结果应该是：

1. 对“完全没有首字节”的卡死链路，可以更快掉到下一个 endpoint / channel
2. 已经开始流输出的请求不会被误打断
3. 即便完全不改 `proxy_logs` schema，这个阶段也已经有实际收益

### Phase 1.5：增加开关，但默认保持保守

如果你希望这能力可控，而不是纯环境变量写死，那么可以紧跟着做这一小相位：

1. `config.ts` 增 `proxyFirstByteTimeoutSec`
2. `settings.ts` 增读写
3. `Settings.tsx` 增输入框

建议默认策略：

1. 代码默认 `0`
2. 部署时按实例情况手动打开

这样风险最低，也方便灰度。

### Phase 2：direct route 渐进补齐

这一步专门处理当前还没走 surface / endpointFlow 主链的 route：

1. `completions.ts`
2. `embeddings.ts`
3. `images.ts`
4. `search.ts`

这里的重点不是复制 upstream 代码，而是按当前仓库结构做 3 件事：

1. `fetch(...)` 包一层 `fetchWithObservedFirstByte(...)`
2. 每次 attempt 单独记录 `attemptStartedAtMs`
3. 统一错误体读取口径

这一步做完后，#383 的“核心行为”才算覆盖到当前项目的所有主要代理入口。

### Phase 3：`proxy_logs` 扩字段 + API 透传

只有在你确认“首字节观测数据值得被长期存储和查询”以后，再进入这个阶段。

范围：

1. schema + migration
2. `legacySchemaCompat`
3. `db/index.ts` 的列探测与 ensure
4. `proxyLogStore.ts` 的新字段写入
5. `stats.ts` / `web/api.ts` 的字段透传

这一步完成后，才进入真正的结构化观测阶段。

### Phase 4：Proxy Logs UI badges

这是最末端的展示层。

只有在前面已经确认：

1. 数据有价值
2. 字段稳定
3. API 返回口径明确

以后，再给 `ProxyLogs.tsx` 加：

1. 流式 / 非流式标识
2. 首字节延迟 badge

这样改动边界更清晰，也不会让 UI 需求反向绑架核心超时能力。

---

## 6. 和当前 protocol-affinity 计划的关系

这部分值得单独讲清楚。

`#383` 和当前的 protocol-affinity 计划不是替代关系，而是互补关系。

两者各自解决的问题不同：

1. protocol-affinity
   - 解决“第一次选错协议，导致同通道内重复降级”
   - 重点是减少无意义 fallback 和日志污染

2. first-byte timeout
   - 解决“协议选得没错，但上游一直不出首字节”
   - 重点是尽早脱离挂死链路

所以更准确的工程判断是：

1. `#383` 核心能力本身就有独立价值
2. 它不需要等 protocol-affinity 全部做完才能上线
3. 但 `proxy_logs` 新字段和 badges 这部分，确实可以等 protocol-affinity
   阶段一起再评估是否值得上 schema

这也和本地同步记录里“建议在 protocol-affinity 阶段参考”的判断一致。

---

## 7. 最终建议

### 7.1 适合现在就做的

1. `firstByteTimeout.ts`
2. `AbortSignal` 透传
3. `endpointFlow()` 首字节超时快路径
4. `chat / responses / gemini` 接入
5. 可选的 runtime setting 开关

### 7.2 适合下一步再做的

1. `completions / embeddings / images / search` 渐进补齐
2. `proxy_logs` 新列
3. stats / web API 透传
4. Proxy Logs badges

### 7.3 不建议现在混做的

1. endpointFlow owner 搬迁
2. 与 #373 相关的 site endpoint pool 架构演进
3. 大范围 schema generated artifacts churn，但核心超时能力尚未落地

---

## 8. 可以直接替换 Claude 文档结论区的简版结论

如果只想保留一个最短版本，建议用下面这段：

> `#383` 值得引入，但当前 fork 不应一次性照搬 upstream 全量补丁。
> 最优顺序是先做“首字节超时核心能力 + surface / endpointFlow 接入 +
> 可配置开关”，把“`proxy_logs` 新列和 UI badges”后置成第二阶段。这样既能
> 快速解决挂死链路问题，又不会在 protocol-affinity 之前过早扩大 schema 和
> UI 改动面。

---

## 9. 采用 #383 的直接收益

这一节只回答一个问题：

- 如果当前仓库真的吸收 #383，最直接能得到什么收益？

### 9.1 更快甩掉“无首字节挂死链路”

这是最核心的收益。

当前项目已经具备：

1. endpoint fallback
2. channel retry
3. 多站点 / 多通道选路

但在“上游已经接受请求，却长时间没有任何首包 / 首 token”的场景下，现有逻辑
仍然容易空等。

引入 #383 后：

1. 这类请求会更早被识别为 retryable timeout
2. 可以更快切到下一个 endpoint 或 channel
3. 不需要等整次请求慢慢耗死

对公益站、兼容站和偶发卡死的上游，这个收益是立刻可感知的。

### 9.2 不会误伤已经开始输出的流

它解决的不是“整次请求太慢”，而是“完全没有首字节”。

所以：

1. 已经开始输出内容的请求
2. 即使后半段速度较慢

也不会被这项超时打断。

这比粗暴的整请求 timeout 更适合当前项目的流式代理场景。

### 9.3 提升终端用户体感

对终端用户来说，行为差异通常会体现在：

1. 少一些长时间转圈
2. 少一些“明明有备用站点却还在傻等”的情况
3. 流式请求更早进入真正输出，或更早失败切换

也就是说，它提升的不是“理论正确性”，而是实际可用性和等待体验。

### 9.4 和 protocol-affinity 是互补关系

这点要特别区分清楚。

当前 protocol-affinity 计划主要解决：

1. 第一次协议选错
2. 同通道内重复降级
3. 日志口径被中间失败污染

而 #383 解决的是另一类问题：

1. 协议不一定选错
2. 但当前上游 attempt 根本不出首字节

所以它不是重复建设，而是对现有 fallback 体系的补强。

### 9.5 如果后续补观测字段，排障会更清楚

如果第二阶段再补：

1. `is_stream`
2. `first_byte_latency_ms`
3. Proxy Logs badges

那排障视角会进一步提升。

到时候可以更清楚地区分：

1. 这次请求是流式还是非流式
2. 是总耗时高
3. 还是首字节就已经很慢

但要强调：

- 这部分是“观测增强”
- 不是 #383 的核心收益来源

### 9.6 对当前 fork 最值钱的收益顺序

如果只看投入产出比，收益优先级大致是：

1. 首字节超时核心能力
2. runtime setting 开关
3. direct route 渐进补齐
4. `proxy_logs` 结构化观测
5. UI badges

也就是说：

- **最值钱的是行为修复**
- **不是日志展示**
