import { isCloudflareChallenge, isTokenExpiredError } from './alertRules.js';

type FailureReasonCategory =
  | 'verification'
  | 'auth'
  | 'network'
  | 'site'
  | 'state'
  | 'unknown';

type FailureReasonCode =
  | 'site_disabled'
  | 'checkin_not_supported'
  | 'manual_turnstile_required'
  | 'cloudflare_tunnel_unavailable'
  | 'cloudflare_challenge'
  | 'token_expired'
  | 'already_checked_in'
  | 'network_timeout'
  | 'upstream_error'
  | 'unknown_error';

type FailureReason = {
  code: FailureReasonCode;
  category: FailureReasonCategory;
  title: string;
  actionHint: string;
  detailHint: string;
};

// Status text stays Chinese (zh is the primary product language); the web side
// maps these known strings through its i18n table for strict-English mode.
// Keep them stable: the web i18n supplement keys off the exact text.

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

export function classifyFailureReason(
  input: { message?: string | null; status?: string | null; httpStatus?: number | null },
): FailureReason {
  const rawMessage = String(input.message || '').trim();
  const text = rawMessage.toLowerCase();
  const status = (input.status || '').toLowerCase();
  const httpStatus = typeof input.httpStatus === 'number' ? input.httpStatus : 0;

  if (status === 'skipped' && includesAny(text, ['site disabled'])) {
    return {
      code: 'site_disabled',
      category: 'site',
      title: '站点已禁用',
      actionHint: '启用站点后再试',
      detailHint: '该账号所属站点处于禁用状态，任务会自动跳过。',
    };
  }

  if (includesAny(text, [
    'checkin endpoint not found',
    '签到端点不存在',
    '站点不支持签到',
    'not support checkin',
    'check-in is not supported',
    'checkin is not supported',
    'does not support checkin',
  ])) {
    return {
      code: 'checkin_not_supported',
      category: 'site',
      title: '站点未开启签到',
      actionHint: '无需重试（非故障）',
      detailHint: '该站点未提供签到端点，账号会被自动跳过。',
    };
  }

  if (includesAny(text, ['turnstile token 为空', 'turnstile']) && includesAny(text, ['校验', 'token', '验证', 'manual'])) {
    return {
      code: 'manual_turnstile_required',
      category: 'verification',
      title: '需要人工验证',
      actionHint: '浏览器先人工签到一次',
      detailHint: '站点开启了 Turnstile 人机验证，自动签到无法直接通过。',
    };
  }

  if (includesAny(text, ['cloudflare tunnel error', 'error 1033', 'unable to resolve it'])) {
    return {
      code: 'cloudflare_tunnel_unavailable',
      category: 'network',
      title: '站点隧道不可用',
      actionHint: '稍后重试或联系站点方',
      detailHint: 'Cloudflare Tunnel 当前不可达，通常是站点侧网络或隧道进程问题。',
    };
  }

  if (isCloudflareChallenge(rawMessage)) {
    return {
      code: 'cloudflare_challenge',
      category: 'verification',
      title: '触发 Cloudflare 验证',
      actionHint: '降低频率并稍后重试',
      detailHint: '请求触发了防护挑战，建议稍后再试或更换稳定站点。',
    };
  }

  if (isTokenExpiredError({ status: httpStatus > 0 ? httpStatus : undefined, message: rawMessage })) {
    return {
      code: 'token_expired',
      category: 'auth',
      title: '令牌失效',
      actionHint: '重新登录或同步新令牌',
      detailHint: '账号访问令牌可能过期或无效，需更新认证信息。',
    };
  }

  if (includesAny(text, ['already checked in', 'already signed', '今天已经签到', '今日已签到', '已经签到'])) {
    return {
      code: 'already_checked_in',
      category: 'state',
      title: '今日已签到',
      actionHint: '无需重复执行',
      detailHint: '该账号当天签到已完成，重复请求会被站点拒绝或跳过。',
    };
  }

  if (includesAny(text, ['timeout', 'timed out', 'etimedout', '请求超时'])) {
    return {
      code: 'network_timeout',
      category: 'network',
      title: '请求超时',
      actionHint: '稍后重试并检查网络',
      detailHint: '请求在超时时间内未完成，可能是网络波动或站点响应慢。',
    };
  }

  if (httpStatus >= 500 || includesAny(text, ['http 5', 'upstream', 'internal server error'])) {
    return {
      code: 'upstream_error',
      category: 'site',
      title: '上游站点错误',
      actionHint: '稍后重试',
      detailHint: '站点返回服务端错误，通常需要站点恢复后才可成功。',
    };
  }

  return {
    code: 'unknown_error',
    category: 'unknown',
    title: status === 'success' ? '执行成功' : '未知错误',
    actionHint: status === 'success' ? '无需操作' : '查看详细日志后重试',
    detailHint: status === 'success'
      ? '任务已成功完成。'
      : '暂未识别到明确错误类型，可根据原始信息进一步排查。',
  };
}
