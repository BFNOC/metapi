# SQLite Migration Recovery 合并方案（Codex）

**日期**: 2026-04-03  
**上游 Commit**: `b9b553d` (#400), `63f6b07` (#410)  
**目标文件**: `src/server/db/migrate.ts`, `src/server/db/migrate.test.ts`  
**结论**: 应合入，顺序必须是 `#400 -> #410`；目标文件文本冲突风险低，但验证阶段存在一个与本次上游补丁无关的本地测试基线问题，必须单独识别。

---

## 1. Executive Summary

1. 当前 fork 在目标文件上**精确等于** `b9b553d^`。
   证据：`git diff b9b553d^ -- src/server/db/migrate.ts src/server/db/migrate.test.ts` 输出为空。

2. 这意味着对这两个文件而言，`#400` 和 `#410` 不是“需要人工改写才能吸收的 fork 冲突”，而是“当前 fork 还没有吸收的上游增量”。

3. `#400` 解决两个真实问题：
   - 旧 SQLite schema 已经存在，但 `__drizzle_migrations` 里的 `created_at` 与当前 journal 漂移时，当前实现不会对齐时间戳。
   - 当 drizzle 遇到“连续多个 migration 都是 duplicate-column / already-exists”时，当前实现只会恢复一次，然后只再跑一次 `migrate()`；如果还要继续恢复下一段序列，就会失败。

4. `#410` 不是独立价值补丁，它是 `#400` 的安全阀。
   - `#400` 把单次 `try-catch` 升级成了可多轮恢复的循环。
   - `#410` 为这个循环加入 retry budget，防止恢复逻辑在“每轮都声称恢复了一点，但永远收敛不了”的情况下卡死。

5. 当前仓库的**文本冲突风险低**，但**验证风险不低**：
   - 当前 `npm test -- src/server/db/migrate.test.ts` 已经不是全绿。
   - 失败用例是 `replays missing migrations before marking a duplicate-column migration as applied`。
   - 失败原因不是 `#400/#410`，而是该测试夹具跳过了 `0008_sqlite_schema_backfill`，却仍继续应用 `0018_excluded_site_ids`，后者依赖 `downstream_api_keys`，导致 setup 阶段直接报 `no such table: downstream_api_keys`。

---

## 2. 当前 Fork 现实

### 2.1 目标文件现状

- 当前 [`migrate.ts`](/Users/chaos/developments/github_go/metapi/src/server/db/migrate.ts) 仍是“单次恢复后只重试一次”的控制流。
- 当前 [`migrate.ts`](/Users/chaos/developments/github_go/metapi/src/server/db/migrate.ts) 已包含本地已有的恢复语义：
  - bootstrap 旧 schema 到 `__drizzle_migrations`
  - duplicate-column 检测
  - multi-statement migration replay
  - `sites.platform + url` 唯一索引冲突前的 legacy sites 去重
- 当前 [`migrate.test.ts`](/Users/chaos/developments/github_go/metapi/src/server/db/migrate.test.ts) 已覆盖：
  - 单语句 duplicate-column 恢复
  - nested cause duplicate-column 恢复
  - 带引号 SQL 的 duplicate-column 恢复
  - multi-statement migration replay
  - site unique index dedup

### 2.2 与上游的准确关系

- 对目标文件执行 `git diff 63f6b07 -- ...` 后，差异恰好就是把 `#400/#410` 新增内容删掉。
- 这说明当前 fork 在这两个文件上不是“与上游并行演化”，而是“停在 `#400` 前一刻”。
- 因此：
  - **文本合并冲突**：低
  - **语义冲突**：低
  - **验证过程中的本地噪音**：中

### 2.3 当前工作区状态

- `git status --short` 显示：
  - `M docs/custom/upstream-sync-log.md`
  - `?? docs/custom/plans/2026-04-03-sqlite-migration-merge.md`
- 这些改动不与 `#400/#410` 的目标文件重叠，但如果要正式提交，建议不要把“上游 cherry-pick”与“文档调整”混在同一个 commit。

---

## 3. 上游 #400 / #410 到底解决什么

### 3.1 #400 (`b9b553d`) 解决的问题

#### 问题 A：stale migration timestamp 无法被纠正

当前 [`migrate.ts`](/Users/chaos/developments/github_go/metapi/src/server/db/migrate.ts#L264) 的 `markMigrationRecordIfMissing()` 只按 `hash` 判断“有无记录”。

现状语义：

```ts
if (existing) {
  return false;
}
```

这会导致：

- 如果某条 migration 的 `hash` 已经存在，但 `created_at` 与当前 journal 不一致，函数会直接跳过。
- 结果是 journal 记录永久漂移，无法在启动时自动收敛回当前 drizzle journal。

`#400` 的修正是：

- 查出同 `hash` 的**最新一条记录**；
- 如果 `created_at` 不一致，则更新最新记录的时间戳；
- 只有当 `hash + created_at` 已一致时，才真正返回“不需要变更”。

#### 问题 B：连续恢复链只支持一步

当前 [`runSqliteMigrations()`](/Users/chaos/developments/github_go/metapi/src/server/db/migrate.ts#L585) 的核心控制流是：

1. 跑一次 `migrate()`
2. 出错后尝试恢复 duplicate-column 或 duplicate-sites
3. 若恢复成功，再跑**一次** `migrate()`
4. 第二次如果再遇到下一条 recoverable migration，就直接抛错

这对“遗留 schema 早于 drizzle journal，且多个 migration 需要逐个补记 / 回放”的场景不够。

`#400` 的修正是：

- 把控制流改成 `while (true)`；
- 每次成功恢复一段后直接 `continue`，重新执行 `migrate()`；
- 直到 `migrate()` 真正无错完成。

#### 问题 C：恢复过程缺少“恢复了几条”的语义

当前 [`recoverMigrationSequence()`](/Users/chaos/developments/github_go/metapi/src/server/db/migrate.ts#L372) 只返回 `boolean`。

这会让调用方无法区分：

- “确实找到并修复了记录”
- “命中路径了，但其实没有任何新记录被补齐”

`#400` 把它改成返回 `number`，并引入结构化结果：

```ts
type DuplicateColumnRecoveryResult = {
  tag: string;
  recoveredCount: number;
};
```

这样调用方可以只在 `recoveredCount > 0` 时继续下一轮迁移。

### 3.2 #410 (`63f6b07`) 解决的问题

`#410` 解决的是 `#400` 引入的**潜在无限循环**。

一旦 `#400` 把迁移控制流改成循环，只要出现下面这种模式，就可能永远跑不完：

1. `migrate()` 抛出 recoverable error
2. recovery path 返回 “我恢复了 1 条”
3. 再次 `migrate()` 又抛出等价错误
4. recovery path 再次返回 “我恢复了 1 条”
5. 无限往复

`#410` 的修正是：

- 引入 `SQLITE_MIGRATION_RECOVERY_RETRY_BUDGET = 64`
- 抽出 `runSqliteMigrationRecoveryLoop()`
- 每次因为 duplicate-column / duplicate-sites 恢复而 `continue` 时都消耗一次 budget
- 超限后关闭 sqlite 连接并抛出带上下文的预算耗尽错误

这让 `#400` 的“多轮恢复”从“理论上更强”变成“工程上可控”。

---

## 4. 关键签名与逻辑变化

### 4.1 函数 / 类型变化

#### `markMigrationRecordIfMissing`

- 当前：
  - 返回 `boolean`
  - 只要 `hash` 已存在，就直接 `false`
- `#400` 后：
  - 仍返回 `boolean`
  - 但“更新时间戳”也算一次变更，返回 `true`
  - 查询从 `SELECT 1` 升级为 `SELECT rowid, created_at ... ORDER BY created_at DESC LIMIT 1`

#### `recoverMigrationSequence`

- 当前：`(...): boolean`
- `#400` 后：`(...): number`

语义变化：

- 当前只回答“有没有进入恢复路径”
- `#400` 后回答“实际有多少条记录被补齐 / 对齐”

#### `recoverDuplicateColumnMigrationError`

- 当前：不存在
- `#400` 后：新增为内部核心函数，返回 `DuplicateColumnRecoveryResult | null`

#### `tryRecoverDuplicateColumnMigrationError`

- 当前：直接做全部工作，返回 `boolean`
- `#400` 后：退化为薄包装，只把结构化结果转成 `boolean`

#### `SqliteMigrationRecoveryLoopInput`

- 当前：不存在
- `#410` 后：新增输入类型，承载迁移循环所需的所有 callback

#### `runSqliteMigrationRecoveryLoop`

- 当前：不存在
- `#410` 后：新增，成为 `runSqliteMigrations()` 的核心控制流 owner

### 4.2 控制流变化

#### 当前 HEAD

```ts
try migrate()
catch error:
  recover duplicate-column once
  or deduplicate sites once
  if recovered:
    migrate() once more
  else:
    throw
```

#### #400 后

```ts
while true:
  try migrate()
  catch error:
    if duplicate-column recovery recoveredCount > 0:
      continue
    if duplicate-sites recovery happened:
      continue
    throw
  break
```

#### #410 后

```ts
runSqliteMigrationRecoveryLoop({
  runMigrate,
  recoverDuplicateColumnMigrationError,
  deduplicateLegacySitesForUniqueIndex,
  retryBudget: 64,
})
```

差别不只是“重构成 helper”。

真正的语义变化是：

- 恢复次数被显式计数
- duplicate-column 和 duplicate-sites 两条恢复分支都纳入同一个 budget
- close / throw 时机被统一

---

## 5. 不合入的风险

### 5.1 如果两个都不合

会保留当前缺陷：

1. 遇到 stale `created_at` 时，journal 不会自动纠正。
2. 遇到连续多段 recoverable migration 时，只能恢复一轮，第二轮可能仍失败。
3. 启动恢复逻辑缺少“本轮到底恢复了多少东西”的明确信号，后续扩展和测试都更脆弱。

### 5.2 如果只合 #400，不合 #410

这是最危险的组合。

风险：

1. 多轮恢复变强了，但没有 budget。
2. 一旦 recovery path 因某种状态抖动持续返回 `recoveredCount > 0`，进程可能卡在迁移循环里。
3. 问题会表现为“启动挂住”而不是一次性失败，排障成本更高。

### 5.3 如果只合 #410，不合 #400

几乎没有意义。

- `#410` 的价值依附于 `#400` 的循环恢复模型。
- 单独抽 loop helper 和 retry budget，不会修复当前 fork 的 stale timestamp 与 sequential recovery 问题。

---

## 6. 本地冲突与冲突处理策略

### 6.1 会发生什么冲突

#### 文本冲突

- 对目标文件而言，**预期无文本冲突**。
- 原因：当前 fork 对这两个文件就是 `b9b553d^`。

#### 语义冲突

- 预期无实质语义冲突。
- 当前 fork 的 `sites` 去重恢复、bootstrap、duplicate-column 恢复都已经在 `#400/#410` 的基础上下文里被保留。
- 上游这两次 commit 只是在现有框架上增强 journal reconciliation 和 recovery loop，不会覆盖本地独有恢复分支。

#### 工作区冲突

- 当前工作区存在文档脏状态，但与目标文件无重叠。
- 仍建议把 merge 与文档提交分开，避免把“分析文档变化”误认为“代码合并变化”。

### 6.2 推荐落地步骤

1. 预检
   - 确认目标文件仍与 `b9b553d^` 一致。
   - 确认当前脏文件只有文档，不含 `src/server/db/migrate.ts` / `migrate.test.ts`。

2. 应用 `#400`
   - 优先用 `git cherry-pick b9b553d`
   - 预期只改两个文件

3. 立即核对 `migrate.ts` 的关键点
   - `markMigrationRecordIfMissing()` 改为可更新时间戳
   - `recoverMigrationSequence()` 改为返回 `number`
   - 新增 `DuplicateColumnRecoveryResult`
   - `runSqliteMigrations()` 改为循环恢复

4. 应用 `#410`
   - `git cherry-pick 63f6b07`
   - 预期仍只改两个文件

5. 再次核对 `migrate.ts` 的关键点
   - 新增 `SQLITE_MIGRATION_RECOVERY_RETRY_BUDGET`
   - 新增 `buildSqliteMigrationRetryBudgetError()`
   - 新增 `runSqliteMigrationRecoveryLoop()`
   - `runSqliteMigrations()` 改为调用 loop helper

6. 测试阶段不要误判
   - 先承认当前基线测试本来就有一条是红的
   - 不要把这条红误判为 `#400/#410` 引入回归

### 6.3 关于当前红色基线测试的处理建议

当前失败命令：

```bash
npm test -- src/server/db/migrate.test.ts
```

当前失败事实：

- 失败用例：`replays missing migrations before marking a duplicate-column migration as applied`
- 报错：`SqliteError: no such table: downstream_api_keys`
- 根因：测试跳过了 `0008_sqlite_schema_backfill`，却继续执行了会修改 `downstream_api_keys` 的后续 migration（当前最先撞到的是 `0018_excluded_site_ids`）

建议处理方式分两种：

#### 方案 A：纯净吸收上游，再做本地测试修复

- 先只 cherry-pick `#400/#410`
- 单独再补一个本地测试修复 commit
- 适合保持 upstream tracking 清晰

#### 方案 B：先修测试夹具，再把它作为 merge gate

- 先修复该测试的 `appliedEntries` 构造方式
- 再用整个 `migrate.test.ts` 作为 merge gate
- 适合追求“文档计划里的验证步骤可直接复制执行”

我的建议是 **方案 A**。

原因：

- 当前红测与 `#400/#410` 无关
- 不应把“吸收上游补丁”与“修本地旧测试债”混成一个逻辑单元
- 但文档里必须明确写出来，否则执行人会被误导

---

## 7. 测试策略

### 7.1 合并前基线验证

1. 运行：

```bash
npm test -- src/server/db/migrate.test.ts
```

2. 记录基线结论：
   - 当前已有 1 条非本次补丁引起的红测
   - 红测发生在 fixture setup，不是 recovery loop 逻辑本身

### 7.2 合并后必查点

#### 针对 #400

- stale timestamp reconciliation
  - `markMigrationRecordIfMissing()` 应只更新同 hash 的最新记录
- legacy schema predates drizzle journal
  - 连续 duplicate-column migration 应能多轮推进，而不是只推进一次
- duplicate-column + multi-statement replay
  - 旧有用例不能退化

#### 针对 #410

- retry budget 达到上限时应 fail fast
- 预算耗尽错误里应带原始 schema 错误上下文
- sqlite 连接应在 budget exceeded 路径下关闭

### 7.3 推荐执行顺序

1. `npm test -- src/server/db/migrate.test.ts`
   - 先确认当前已知红测是否仍只有那一条

2. `npm run typecheck`
   - `#410` 新增了类型 `SqliteMigrationRecoveryLoopInput`
   - 需要确认 helper 导出与测试中的类型断言无误

3. 如果这次合并还碰了共享边界，再补：

```bash
npm run repo:drift-check
```

对仅这两个文件的原样 cherry-pick，`repo:drift-check` 不是强制 gate，但跑了更稳妥。

---

## 8. 回滚方案

优先使用**非破坏性回滚**。

### 8.1 推荐回滚方式

```bash
git revert 63f6b07
git revert b9b553d
```

顺序原因：

- `#410` 依赖 `#400`
- 先撤 `#410` 更安全

### 8.2 如果只需要撤掉 retry budget 封装

```bash
git revert 63f6b07
```

这会回到“有多轮恢复、但没有 budget helper”的 `#400` 状态。

### 8.3 数据侧检查

回滚代码后，应检查：

```sql
SELECT rowid, hash, created_at
FROM __drizzle_migrations
ORDER BY created_at DESC, rowid DESC;
```

关注点：

- 是否存在同 hash 多行但时间戳不一致
- 是否有最新 migration 的 `created_at` 被对齐过

这里通常不需要回滚数据，除非你已经在异常状态下多次启动并把 journal 写乱。

---

## 9. 风险评估

### 9.1 低风险

- 目标文件文本冲突
- 现有 site dedup 分支被覆盖
- 现有 duplicate-column recovery 基础能力丢失

### 9.2 中风险

- 合并后验证时把当前红测误判为新回归
- 由于工作区已有文档脏状态，提交时把无关文件混进 merge commit

### 9.3 高风险

- 只合 `#400` 不合 `#410`
- 合并时没意识到 recovery loop 已从“单次重试”变成“预算控制循环”
- 生产上出现 budget exhausted 时，被误认为随机 SQLite 波动，而不是 recovery 不收敛

---

## 10. 与 Claude 方案的比较

仓库中已有 [`2026-04-03-sqlite-migration-merge.md`](/Users/chaos/developments/github_go/metapi/docs/custom/plans/2026-04-03-sqlite-migration-merge.md)，标注分析者为 Claude。

### 10.1 我同意的部分

1. `#400` 和 `#410` 应按顺序合入。
2. 对目标文件而言，它们更像是“上游增量吸收”，不是“高冲突 fork 改写”。
3. `#410` 的本质确实是给 recovery loop 加 budget。

### 10.2 我认为 Claude 方案不够精确的地方

#### 1. “无冲突的本地修改” 这个表述太宽

更准确的说法应该是：

- **在目标文件的最终文本上**，当前 fork 与 `b9b553d^` 完全一致；
- 不是说这两个文件从未有过本地历史修改；
- 也不是说整个工作区是干净的。

这一区分在实际操作里很重要，因为它决定了我们是“放心 cherry-pick 代码”，还是“错误地以为整个仓库都没有本地状态”。

#### 2. 它把验证说得过于理想化

Claude 文档默认把“跑测试”写成线性步骤，但没有指出当前基线已经有一条红测。

真实执行时，如果不知道这件事，会立刻得出错误结论：

- “是不是 #400/#410 导致 migrate test 挂了？”

而事实不是。

#### 3. 它没有把 `#410` 的风险边界讲透

更准确的风险描述应该是：

- 当前 HEAD 不合 `#400/#410`，不会有无限循环，只是恢复能力不足；
- **只有在引入 `#400` 的循环恢复模型之后，`#410` 的 budget 才变成必须项**。

#### 4. 它的回滚建议里不该优先出现破坏性命令

`git reset --hard HEAD~2` 对真实 fork 工作区太粗暴。

对这种“分析 merge plan”文档，更合理的默认建议是：

- 优先 `git revert`
- 明确区分“撤上游 commit”和“处理本地脏状态”

### 10.3 总结

Claude 的大方向是对的：

- 要合
- 要顺序合
- 核心变化在 recovery logic

我的补充是把三件事说清楚：

1. **为什么这两个 commit 解决的是当前实现的真实缺口**
2. **为什么目标文件几乎没有 merge 冲突，但验证并不等于无风险**
3. **为什么 `#410` 是 `#400` 的安全阀，而不是可选优化**

---

## 11. 最终建议

建议执行路径：

1. 保持这次上游吸收只包含 `b9b553d` 和 `63f6b07`
2. 顺序合入：`#400 -> #410`
3. 合入后先做 targeted verification
4. 将当前 `migrate.test.ts` 的红测视为**独立基线债**处理，不要与本次上游合并绑定成一个 commit

一句话总结：

**这两个 commit 值得合，而且对目标文件几乎就是干净吸收；真正需要小心的不是 merge conflict，而是把当前本地测试夹具债误判成上游补丁回归。**
