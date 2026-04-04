# 探活状态分类优化 - 更激进的失败判定

**日期**: 2026-04-04
**目标**: 将明确的服务不可用情况从 `inconclusive`（未知）改为 `unsupported`（失败）

## 问题背景

当前探活功能将以下明确的失败情况归类为"未知"（inconclusive）：

### HTTP 5xx 错误
- `502 Bad Gateway`
- `503 Service temporarily unavailable`
- `521` Cloudflare 错误
- `500 Internal Server Error`

### 超时错误
- `Timeout after 15000ms`

### 网络错误
- `fetch failed`

### 配置错误
- `unknown provider for model gpt-5.4`
- `分组 xxx 下模型 xxx 无可用渠道（distributor）`
- `当前分组 xxx 下对于模型 xxx 无可用渠道`

### 资源过载
- `system disk overloaded`
- `system cpu overloaded`

### HTML 错误页
- `<!DOCTYPE html> <!--` (Cloudflare 拦截页面)

## 现状分析

**文件**: `src/server/services/modelProbeService.ts`

### 当前逻辑

```typescript
function classifyHttpFailure(status: number, errorBody: string | null): ProbeResult['status'] {
  if (status === 401 || status === 403 || status === 429) return 'skipped';
  if (isUnsupportedModelError(status, errorBody)) return 'unsupported';
  if (status >= 500) return 'inconclusive';  // ❌ 问题：5xx 应该是失败
  return 'inconclusive';                      // ❌ 问题：其他错误也应该是失败
}
```

```typescript
catch (error: any) {
  if (error?.name === 'AbortError') {
    if (abortedByExternal) return { status: 'skipped', ... };
    return { status: 'inconclusive', ... };  // ❌ 问题：超时应该是失败
  }
  return { status: 'inconclusive', ... };    // ❌ 问题：网络错误应该是失败
}
```

## 改进方案

### 1. 新增服务不可用判定函数

```typescript
function isServiceUnavailableError(status: number, errorBody: string | null): boolean {
  // 5xx errors are definitive failures
  if (status >= 500) return true;

  if (!errorBody) return false;
  const normalized = errorBody.toLowerCase();

  // Configuration errors (no available channels/providers)
  if (normalized.includes('无可用渠道') || normalized.includes('无可用渠道（distributor）')) return true;
  if (normalized.includes('unknown provider')) return true;

  // Service unavailable messages
  if (normalized.includes('service temporarily')) return true;
  if (normalized.includes('bad gateway')) return true;
  if (normalized.includes('overload')) return true;

  // HTML error pages (Cloudflare, etc.)
  if (normalized.includes('<!doctype html>')) return true;
  if (normalized.includes('<html')) return true;

  return false;
}
```

### 2. 修改 HTTP 失败分类逻辑

```typescript
function classifyHttpFailure(status: number, errorBody: string | null): ProbeResult['status'] {
  // Auth/rate-limit issues - skip
  if (status === 401 || status === 403 || status === 429) return 'skipped';

  // Model not found - unsupported
  if (isUnsupportedModelError(status, errorBody)) return 'unsupported';

  // Service unavailable - unsupported (not inconclusive)
  if (isServiceUnavailableError(status, errorBody)) return 'unsupported';

  // Default: treat as unsupported
  return 'unsupported';
}
```

### 3. 修改超时和网络错误处理

```typescript
catch (error: any) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    if (abortedByExternal) {
      return { status: 'skipped', ... };
    }
    // 超时 = 失败
    return { status: 'unsupported', ttftMs: timeoutMs, error: `Timeout after ${timeoutMs}ms`, ... };
  }
  // 网络错误 = 失败
  return { status: 'unsupported', error: error?.message || 'Unknown error', ... };
}
```

## 预期效果

### 修改前
- ✅ 5 成功
- ❌ 7 失败
- ❓ 21 未知

### 修改后
- ✅ 5 成功
- ❌ 28 失败 (7 + 21)
- ❓ 0 未知

## 测试计划

### 1. 单元测试

创建 `src/server/services/modelProbeService.test.ts`，覆盖：

- ✅ 5xx 错误 → `unsupported`
- ✅ 超时 → `unsupported`
- ✅ 网络错误 → `unsupported`
- ✅ 配置错误（无可用渠道）→ `unsupported`
- ✅ HTML 错误页 → `unsupported`
- ✅ 401/403/429 → `skipped`
- ✅ 200 + 有数据 → `supported`
- ✅ 404 + model not found → `unsupported`

### 2. 集成测试

使用现有的 `/api/sites/:id/probe-models` 端点：

```bash
# 测试超时场景
curl -X POST http://localhost:3000/api/sites/1/probe-models \
  -H "Content-Type: application/json" \
  -d '{"modelNames": ["gpt-5.4"], "timeoutMs": 1000}'

# 预期：status: "unsupported", error: "Timeout after 1000ms"
```

### 3. 手动验证

在 UI 界面触发批量探活，观察：
- 未知数量应该显著减少
- 失败数量应该显著增加
- 错误信息保持清晰可读

## 实施步骤

1. ✅ 编写计划文档（本文档）
2. ⬜ 编写单元测试（TDD）
3. ⬜ 实现 `isServiceUnavailableError` 函数
4. ⬜ 修改 `classifyHttpFailure` 函数
5. ⬜ 修改超时和网络错误处理
6. ⬜ 运行测试验证
7. ⬜ 手动测试验证
8. ⬜ 提交代码

## 风险评估

**低风险**：
- 不修改类型定义（仍然是 4 种状态）
- 不影响前端展示逻辑
- 只是重新分类，error 信息保持不变
- 向后兼容

## 参考

- 相关文件：`src/server/services/modelProbeService.ts`
- 相关路由：`src/server/routes/api/sites.ts` (line 798-935)
- 测试示例：`src/server/routes/api/sites.batch.test.ts`
