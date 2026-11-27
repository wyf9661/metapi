import { tr } from './i18n.js';
function normalizeReason(reason: string): string {
  return (reason || '').trim().toLowerCase();
}

export function resolveLoginErrorMessage(status: number, reason: string): string {
  const normalizedReason = normalizeReason(reason);
  if (status === 403 && normalizedReason.includes('ip not allowed')) {
    return tr('当前 IP 不在管理白名单中');
  }
  if (status === 429) {
    // Brute-force throttle: this address burned its failure budget, so even the
    // right token is refused until the block window ends. Saying "check the
    // service" here sends the operator hunting for an outage that is not there.
    return tr('登录尝试过于频繁，请稍后重试（服务本身正常）');
  }
  if (status === 401 || (status === 403 && normalizedReason.includes('invalid token'))) {
    return tr('登录令牌无效');
  }
  if (status >= 500) {
    return tr('服务端异常，请稍后重试');
  }
  return tr('登录失败，请检查服务状态');
}
