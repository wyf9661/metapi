import { tr } from '../../i18n.js';
type VerifyResultLike = {
  success?: boolean;
  needsUserId?: boolean;
  invalidUserId?: boolean;
  message?: string | null;
} | null | undefined;

function normalizeMessageText(message: unknown): string {
  return typeof message === 'string' ? message.trim() : '';
}

export function isNetworkFailureMessage(message: unknown): boolean {
  const lowered = normalizeMessageText(message).toLowerCase();
  return lowered.includes('failed to fetch')
    || lowered.includes('fetch failed')
    || lowered.includes('networkerror')
    || lowered.includes('load failed');
}

export function isTimeoutFailureMessage(message: unknown): boolean {
  const lowered = normalizeMessageText(message).toLowerCase();
  return lowered.includes('timed out')
    || lowered.includes('timeout')
    || lowered.includes('请求超时');
}

export function normalizeVerifyFailureMessage(message: unknown): string {
  const text = normalizeMessageText(message);
  if (!text) return tr('验证失败');
  const lowered = text.toLowerCase();
  if (isNetworkFailureMessage(text)) {
    return tr('无法连接到 metapi 服务端，请检查服务状态或网络连接');
  }
  if (lowered.includes('user id mismatch') || lowered.includes('does not match this token')) {
    return tr('填写的用户 ID 与当前 Token / Cookie 不匹配');
  }
  return text;
}

export function buildVerifyFailureHint(result: VerifyResultLike): string | null {
  if (!result || result.success || result.needsUserId) return null;
  if (result.invalidUserId) {
    return tr('这不是 Token 错误判断。请检查填写的用户 ID 是否与当前 Token / Cookie 属于同一账号。');
  }
  if (isNetworkFailureMessage(result.message)) {
    return tr('这不是 Token 错误判断。请检查 metapi 服务是否在线，以及目标站点或代理是否可达。');
  }
  if (isTimeoutFailureMessage(result.message)) {
    return tr('这不是 Token 错误判断。目标站点响应超时，请稍后重试或检查代理/网络。');
  }
  return tr('请检查 Token 是否正确');
}

export function buildAddAccountPrereqHint(result: VerifyResultLike): string {
  if (!result) {
    return tr('请先点击“验证 Token”，验证成功后才能添加账号。');
  }
  if (result.success) return '';
  if (result.needsUserId) {
    return tr('请先补充用户 ID 并重新验证，验证成功后才能添加账号。');
  }
  if (result.invalidUserId) {
    return tr('请先修正用户 ID 并重新验证，验证成功后才能添加账号。');
  }
  if (isNetworkFailureMessage(result.message)) {
    return tr('验证请求未成功完成，请先检查 metapi 服务、站点网络或代理配置。');
  }
  if (isTimeoutFailureMessage(result.message)) {
    return tr('验证请求超时，请先检查站点或代理连通性后再添加账号。');
  }
  return tr('请先点击“验证 Token”，验证成功后才能添加账号。');
}
