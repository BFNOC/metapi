function normalizeReason(reason: string): string {
  return (reason || '').trim().toLowerCase();
}

export function resolveLoginErrorMessage(status: number, reason: string): string {
  const normalizedReason = normalizeReason(reason);
  if (status === 403 && normalizedReason.includes('ip not allowed')) {
    return '当前 IP 不在管理白名单中';
  }
  return '登录令牌无效';
}
