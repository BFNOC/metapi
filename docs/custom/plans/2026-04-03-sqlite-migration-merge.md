# SQLite Migration Recovery 合并方案

**日期**: 2026-04-03
**上游 PR**: #400 (b9b553d), #410 (63f6b07)
**影响文件**: `src/server/db/migrate.ts`, `src/server/db/migrate.test.ts`
**分析者**: Claude Opus 4.6

---

## 1. 背景说明

### 1.1 上游 #400 (b9b553d) - 修复 SQLite 迁移日志恢复

**提交信息**: `[codex] fix sqlite migration journal recovery`
**提交时间**: 2026-04-02 17:28:45

**核心目标**:
- 修复迁移日志时间戳不一致问题（约 70 分钟漂移）
- 增强迁移序列恢复的健壮性
- 支持遗留 schema 与 drizzle journal 的协调

**主要改动**:
1. `markMigrationRecordIfMissing`: 当 hash 存在但时间戳不同时，更新时间戳而非跳过
2. `recoverMigrationSequence`: 返回类型从 `boolean` 改为 `number`（恢复计数）
3. `recoverDuplicateColumnMigrationError`: 新增函数，返回结构化结果 `{ tag, recoveredCount }`
4. `runSqliteMigrations`: 从 try-catch 单次重试改为 while 循环多次重试
5. `backfillMissingRecordedMigrations`: 增加时间戳协调逻辑

### 1.2 上游 #410 (63f6b07) - 限制 SQLite 迁移恢复重试次数

**提交信息**: `[daily] cap sqlite migration recovery retries`
**提交时间**: 2026-04-03 11:10:55

**核心目标**:
- 防止迁移恢复陷入无限循环
- 添加重试预算机制（默认 64 次）
- 提供清晰的错误信息

**主要改动**:
1. 新增类型 `SqliteMigrationRecoveryLoopInput`
2. 新增常量 `SQLITE_MIGRATION_RECOVERY_RETRY_BUDGET = 64`
3. 新增函数 `buildSqliteMigrationRetryBudgetError`
4. 新增函数 `runSqliteMigrationRecoveryLoop`: 封装重试逻辑 + 预算控制
5. `runSqliteMigrations`: 使用新的 loop 函数替代 while 循环
6. 导出测试工具: `__migrateTestUtils` 增加相关函数

---

## 2. 本地现状分析

### 2.1 当前代码状态

**本地版本**: 上游 #400 之前的状态

**关键函数签名**:
```typescript
// 当前本地版本
function markMigrationRecordIfMissing(sqlite: Database.Database, record: MigrationRecord): boolean {
  // 如果 hash 存在，直接返回 false（不更新时间戳）
  const existing = sqlite.prepare('SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = ? LIMIT 1').get(record.hash);
  if (existing) {
    return false;
  }
  // ...
}

function recoverMigrationSequence(...): boolean {
  // 返回 boolean
}

function tryRecoverDuplicateColumnMigrationError(...): boolean {
  // 直接返回 boolean
}

export function runSqliteMigrations(): void {
  // 使用 try-catch 单次重试模式
  try {
    migrate(drizzle(sqlite), { migrationsFolder });
  } catch (error) {
    const recoveredDuplicateColumns = tryRecoverDuplicateColumnMigrationError(...);
    const recoveredDuplicateSites = ...;
    if (!recoveredDuplicateColumns && !recoveredDuplicateSites) {
      sqlite.close();
      throw error;
    }
    migrate(drizzle(sqlite), { migrationsFolder }); // 单次重试
  }
}
```

### 2.2 本地修改历史

通过 `git log` 分析，本地在以下时间点修改过 migrate.ts:
- `7706cec`: 修复 sqlite migration gaps
- `5c6f262`: 实现 duplicate-column 恢复（已被上游吸收）

**结论**: ✅ 本地当前版本与上游 #400 之前的版本一致，**无冲突的本地修改**。

---

## 3. 冲突点识别

### 3.1 函数签名变更

| 函数名 | 本地签名 | #400 后签名 | #410 后签名 |
|--------|---------|------------|------------|
| `markMigrationRecordIfMissing` | `(...) => boolean` | `(...) => boolean`<br/>（逻辑变更：更新时间戳） | 无变化 |
| `recoverMigrationSequence` | `(...) => boolean` | `(...) => number` | 无变化 |
| `tryRecoverDuplicateColumnMigrationError` | `(...) => boolean` | `(...) => boolean`<br/>（内部调用新函数） | 无变化 |
| `recoverDuplicateColumnMigrationError` | ❌ 不存在 | ✅ `(...) => DuplicateColumnRecoveryResult \| null` | 无变化 |
| `runSqliteMigrationRecoveryLoop` | ❌ 不存在 | ❌ 不存在 | ✅ `(input: ...) => void` |

### 3.2 类型定义变更

**新增类型**:
- #400: `DuplicateColumnRecoveryResult = { tag: string; recoveredCount: number }`
- #410: `SqliteMigrationRecoveryLoopInput = { runMigrate, recoverDuplicateColumnMigrationError, ... }`

### 3.3 控制流变更

**本地 (try-catch 单次重试)** → **#400 (while 循环多次重试)** → **#410 (封装函数 + 预算控制)**

详见附录 A。

### 3.4 测试用例变更

**#400 新增测试**:
- `updates only the latest matching migration record when reconciling stale timestamps`
- `recovers sequential duplicate-column migrations when a legacy sqlite schema predates the drizzle journal`
- `reconciles stale migration timestamps when the latest migration hash already exists`

**#410 新增测试**:
- `fails fast when duplicate-column recovery exceeds the retry budget`

---

## 4. 合并策略

### 4.1 总体方案

**策略**: ✅ 顺序应用上游 commits（无冲突，可直接 cherry-pick）

**原因**:
1. ✅ 本地无冲突的自定义修改
2. ✅ #400 和 #410 是顺序依赖关系（#410 基于 #400）
3. ✅ 改动是增量式的，不涉及逻辑冲突
4. ✅ 测试覆盖完善

### 4.2 分步执行

#### 步骤 1: 应用 #400 (b9b553d)

```bash
# 使用代理
export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 all_proxy=socks5://127.0.0.1:7897

# Cherry-pick
git cherry-pick b9b553d
```

**预期变更**:
- `migrate.ts`: +189 行 / -25 行
- `migrate.test.ts`: +120 行新增测试
- 新增 3 个测试用例
- 重构 5 个核心函数

**验证点**:
- [ ] TypeScript 编译通过 (`npm run build`)
- [ ] 测试套件全部通过 (`npm test -- migrate.test.ts`)
- [ ] 函数签名变更正确（`recoverMigrationSequence` 返回 `number`）

#### 步骤 2: 应用 #410 (63f6b07)

```bash
git cherry-pick 63f6b07
```

**预期变更**:
- `migrate.ts`: +116 行 / -25 行
- `migrate.test.ts`: +43 行新增测试
- 新增 1 个测试用例
- 新增 2 个函数，1 个类型，1 个常量

**验证点**:
- [ ] TypeScript 编译通过
- [ ] 测试套件全部通过
- [ ] 重试预算机制生效（运行新增测试）

#### 步骤 3: 集成测试

```bash
# 运行完整测试套件
npm test

# 手动测试迁移流程（可选）
rm -rf /tmp/test-migrate-db
DATA_DIR=/tmp/test-migrate-db npm run dev
```

**验证点**:
- [ ] 所有测试通过
- [ ] 迁移日志无异常
- [ ] 数据库 schema 正确

---

## 5. 风险评估

### 5.1 高风险点

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 时间戳协调逻辑错误 | 迁移记录不一致 | 运行完整测试套件，检查 `markMigrationRecordIfMissing` 逻辑 |
| 重试预算设置不当 | 合法恢复被截断 | 默认 64 次足够，可通过 `retryBudget` 参数调整 |
| while 循环死循环 | 进程挂起 | #410 已添加预算控制，测试覆盖 |

### 5.2 中风险点

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 测试用例依赖环境 | CI/CD 失败 | 本地运行测试，确保 tmpdir 可写 |
| 类型定义不兼容 | 编译错误 | TypeScript 严格模式检查 |

### 5.3 低风险点

- 日志输出格式变化（不影响功能）
- 测试工具导出增加（向后兼容）

---

## 6. 回滚方案

### 6.1 快速回滚

```bash
# 回滚到合并前状态
git reset --hard HEAD~2

# 或者单独回滚某个 commit
git revert 63f6b07  # 回滚 #410
git revert b9b553d  # 回滚 #400
```

### 6.2 数据库回滚

**场景**: 迁移执行后发现问题

**方案**:
1. 停止服务
2. 恢复数据库备份（如果有）
3. 或手动修复 `__drizzle_migrations` 表

```sql
-- 检查迁移记录
SELECT * FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 10;

-- 如果时间戳错误，手动修正
UPDATE __drizzle_migrations
SET created_at = <correct_timestamp>
WHERE hash = '<migration_hash>';
```

### 6.3 渐进式回滚

如果只有 #410 有问题，可以只回滚 #410，保留 #400:

```bash
git revert 63f6b07
```

---

## 7. 验证清单

### 7.1 代码层面

- [ ] TypeScript 编译无错误 (`npm run build`)
- [ ] ESLint 检查通过 (`npm run lint`)
- [ ] 所有测试通过 (`npm test`)
- [ ] 新增测试覆盖关键路径

### 7.2 功能层面

- [ ] 全新数据库初始化成功
- [ ] 遗留 schema 升级成功
- [ ] duplicate-column 错误恢复正常
- [ ] 重试预算限制生效
- [ ] 时间戳协调逻辑正确

### 7.3 性能层面

- [ ] 迁移时间无显著增加
- [ ] 内存占用正常
- [ ] 无死循环或挂起

### 7.4 日志层面

- [ ] 恢复日志清晰可读
- [ ] 错误信息包含足够上下文
- [ ] 重试预算超限时有明确提示

---

## 8. 执行时间表

| 阶段 | 预计时间 | 负责人 |
|------|---------|--------|
| 代码审查 | 30 分钟 | 开发者 |
| 应用 #400 | 10 分钟 | 开发者 |
| 测试验证 | 20 分钟 | 开发者 |
| 应用 #410 | 10 分钟 | 开发者 |
| 集成测试 | 30 分钟 | 开发者 |
| 文档更新 | 15 分钟 | 开发者 |
| **总计** | **115 分钟** | |

---

## 9. 后续行动

### 9.1 文档更新

- [ ] 更新 `docs/custom/upstream-sync-log.md`
- [ ] 记录合并时间和 commit hash
- [ ] 标记 #400 和 #410 为已合并

### 9.2 监控

- [ ] 观察生产环境迁移日志（如适用）
- [ ] 收集用户反馈
- [ ] 监控错误率

### 9.3 技术债务

- [ ] 考虑将重试预算配置化（环境变量）
- [ ] 增加迁移性能指标收集
- [ ] 优化测试用例执行速度

---

## 附录 A: 关键代码差异

### A.1 markMigrationRecordIfMissing 变更

**变更前**:
```typescript
const existing = sqlite
  .prepare('SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = ? LIMIT 1')
  .get(record.hash);
if (existing) {
  return false; // 直接跳过
}
```

**变更后**:
```typescript
const existing = sqlite
  .prepare('SELECT rowid, "created_at" FROM "__drizzle_migrations" WHERE "hash" = ? ORDER BY "created_at" DESC LIMIT 1')
  .get(record.hash) as { rowid?: number; created_at?: number } | undefined;
if (existing) {
  if (Number(existing.created_at) === record.createdAt) {
    return false;
  }
  // 更新时间戳
  sqlite
    .prepare('UPDATE "__drizzle_migrations" SET "created_at" = ? WHERE rowid = ?')
    .run(record.createdAt, existing.rowid);
  return true;
}
```

### A.2 runSqliteMigrations 控制流变更

**#400 前 (try-catch)**:
```typescript
try {
  migrate(drizzle(sqlite), { migrationsFolder });
} catch (error) {
  const recoveredDuplicateColumns = tryRecoverDuplicateColumnMigrationError(sqlite, migrationsFolder, error);
  const recoveredDuplicateSites = (
    !recoveredDuplicateColumns
    && isSitesPlatformUrlUniqueConflictError(error)
    && deduplicateLegacySitesForUniqueIndex(sqlite)
  );
  if (!recoveredDuplicateColumns && !recoveredDuplicateSites) {
    sqlite.close();
    throw error;
  }
  migrate(drizzle(sqlite), { migrationsFolder });
}
```

**#400 后 (while 循环)**:
```typescript
while (true) {
  try {
    migrate(drizzle(sqlite), { migrationsFolder });
    break;
  } catch (error) {
    const duplicateColumnRecovery = recoverDuplicateColumnMigrationError(sqlite, migrationsFolder, error);
    if (duplicateColumnRecovery) {
      if (duplicateColumnRecovery.recoveredCount > 0) {
        continue;
      }
      sqlite.close();
      throw error;
    }

    const recoveredDuplicateSites = (
      isSitesPlatformUrlUniqueConflictError(error)
      && deduplicateLegacySitesForUniqueIndex(sqlite)
    );
    if (recoveredDuplicateSites) {
      continue;
    }

    sqlite.close();
    throw error;
  }
}
```

**#410 后 (封装函数)**:
```typescript
runSqliteMigrationRecoveryLoop({
  runMigrate: () => {
    migrate(drizzle(sqlite), { migrationsFolder });
  },
  recoverDuplicateColumnMigrationError: (error) => (
    recoverDuplicateColumnMigrationError(sqlite, migrationsFolder, error)
  ),
  isSitesPlatformUrlUniqueConflictError,
  deduplicateLegacySitesForUniqueIndex: () => deduplicateLegacySitesForUniqueIndex(sqlite),
  closeSqlite: () => sqlite.close(),
});
```

---

**文档版本**: 1.0
**创建时间**: 2026-04-03
**最后更新**: 2026-04-03
