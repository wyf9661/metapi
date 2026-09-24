import { createHmac } from 'node:crypto';
import { fetch } from 'undici';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { withExplicitProxyRequestInit } from './siteProxy.js';
import nodemailer, { type Transporter } from 'nodemailer';
import {
  createNotificationSignature,
  evaluateNotificationThrottle,
  pruneNotificationThrottleState,
  type NotificationThrottleState,
} from './notificationThrottle.js';
import { formatLocalDateTime, getResolvedTimeZone } from './localTimeService.js';

type NotificationChannel = 'webhook' | 'serverchan' | 'telegram' | 'smtp';

/**
 * A push channel is one bot webhook plus its own signing secret. Channels are
 * independent rows so DingTalk and Feishu (different URLs, different secrets,
 * different signing) can be enabled at the same time.
 */
export type NotifyChannelKind = 'dingtalk' | 'feishu' | 'wecom' | 'custom';

export type NotifyChannel = {
  id: string;
  url: string;
  secret: string;
  enabled: boolean;
  label?: string;
  /** Explicit platform choice from the UI; falls back to URL detection. */
  kind?: NotifyChannelKind;
};

export const NOTIFY_CHANNEL_LABELS: Record<NotifyChannelKind, string> = {
  dingtalk: '钉钉',
  feishu: '飞书',
  wecom: '企业微信',
  custom: '自定义 Webhook',
};

/**
 * The platform is derived from the URL host: the three supported bots use fixed
 * hosts and paths, and the body shape plus the signing placement differ per
 * platform, so the URL alone decides how a channel is called.
 */
export function resolveNotifyChannelKind(url: string): NotifyChannelKind {
  if (isWeComBotWebhook(url)) return 'wecom';
  if (isFeishuBotWebhook(url)) return 'feishu';
  if (isDingTalkBotWebhook(url)) return 'dingtalk';
  return 'custom';
}

export type SendNotificationOptions = {
  bypassThrottle?: boolean;
  requireChannel?: boolean;
  throwOnFailure?: boolean;
  timeoutMs?: number;
};

export type NotificationDispatchResult = {
  throttled: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
  failedChannels: NotificationChannel[];
};

let cachedSmtpFingerprint = '';
let cachedTransporter: Transporter | null = null;
const notificationThrottleState = new Map<string, NotificationThrottleState>();
const DEFAULT_NOTIFICATION_TIMEOUT_MS = 15_000;

function normalizeNotificationTimeoutMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_NOTIFICATION_TIMEOUT_MS;
  return Math.max(1, Math.trunc(parsed));
}

function withNotificationTimeout<T>(
  channel: NotificationChannel,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort(new Error(`${channel} notification timeout (${timeoutMs}ms)`));
  }, timeoutMs);
  return Promise.race([
    run(controller.signal),
    new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error(`${channel} notification timeout (${timeoutMs}ms)`));
      }, { once: true });
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
}

function getSmtpFingerprint() {
  return [
    config.smtpHost,
    config.smtpPort,
    config.smtpSecure ? '1' : '0',
    config.smtpUser,
    config.smtpPass,
    config.smtpFrom,
    config.smtpTo,
  ].join('|');
}

function getSmtpTransporter() {
  const fingerprint = getSmtpFingerprint();
  if (cachedTransporter && cachedSmtpFingerprint === fingerprint) {
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser
      ? {
        user: config.smtpUser,
        pass: config.smtpPass,
      }
      : undefined,
  });
  cachedSmtpFingerprint = fingerprint;
  return cachedTransporter;
}

function buildTimeFootnote(now: Date): string {
  // User-facing notifications only show local time.
  return `时间: ${formatLocalDateTime(now)}`;
}

function buildTelegramText(
  title: string,
  message: string,
  level: 'info' | 'warning' | 'error',
  timeFootnote: string,
): string {
  const maxTextLength = 3900;
  const raw = `[metapi][${level.toUpperCase()}] ${title}\n\n${message}\n\nLevel: ${level}\n${timeFootnote}`;
  if (raw.length <= maxTextLength) return raw;
  return `${raw.slice(0, maxTextLength)}\n\n...(truncated)`;
}

function isWeComBotWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'qyapi.weixin.qq.com' && parsed.pathname.includes('/cgi-bin/webhook/send');
  } catch {
    return false;
  }
}

function buildWeComText(
  title: string,
  message: string,
  level: 'info' | 'warning' | 'error',
  timeFootnote: string,
): string {
  const maxLength = 1900;
  const raw = `[metapi][${level.toUpperCase()}] ${title}\n\n${message}\n\n${timeFootnote}`;
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}\n...(truncated)`;
}

function isFeishuBotWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === 'open.feishu.cn' || parsed.hostname === 'open.larksuite.com')
      && parsed.pathname.includes('/open-apis/bot/v2/hook/')
    );
  } catch {
    return false;
  }
}

function buildFeishuText(
  title: string,
  message: string,
  level: 'info' | 'warning' | 'error',
  timeFootnote: string,
): string {
  const maxLength = 3900;
  const raw = `[metapi][${level.toUpperCase()}] ${title}\n\n${message}\n\n${timeFootnote}`;
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}\n...(truncated)`;
}

/**
 * Feishu / Lark custom-bot 签名校验.
 *
 * Unlike DingTalk (which signs a URL query), Feishu signs the request BODY and
 * expects the two extra fields next to `msg_type`. Algorithm per the open
 * platform docs:
 *
 *   stringToSign = `${timestamp}\n${secret}`   // timestamp in SECONDS
 *   sign         = base64(HMAC-SHA256(key = stringToSign, message = ""))
 *
 * A bot with 签名校验 enabled rejects an unsigned request, so the secret must
 * be configured in the 设置页 when the bot has it turned on.
 */
function signFeishuBody<T extends Record<string, unknown>>(
  body: T,
  secret: string,
  nowMs = Date.now(),
): T & { timestamp: string; sign: string } {
  const timestamp = String(Math.floor(nowMs / 1000));
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = createHmac('sha256', stringToSign).update('').digest('base64');
  return { ...body, timestamp, sign };
}


function isDingTalkBotWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'oapi.dingtalk.com' && parsed.pathname.includes('/robot/send');
  } catch {
    return false;
  }
}

/**
 * Signing secret for a bot webhook, shared by DingTalk 加签 and Feishu 签名校验.
 * Sources, in order: an explicit query parameter pasted into the URL, then the
 * configured secret (WEBHOOK_SECRET / 设置页的「加签密钥」).
 */
function extractWebhookSigningSecret(url: string, channelSecret = ''): string {
  try {
    const parsed = new URL(url);
    // Prefer explicit secret query; also accept common aliases users might paste.
    const candidates = [
      parsed.searchParams.get('secret'),
      parsed.searchParams.get('sec'),
      parsed.searchParams.get('webhook_secret'),
    ];
    for (const value of candidates) {
      const text = String(value || '').trim();
      if (text) return text;
    }
  } catch {}
  // Channel-level secret (the 加签密钥 configured next to the URL).
  return String(channelSecret || '').trim();
}

function buildDingTalkSignedUrl(url: string, secret: string, nowMs = Date.now()): string {
  const parsed = new URL(url);
  // Remove any stale static sign/timestamp so we always regenerate.
  parsed.searchParams.delete('timestamp');
  parsed.searchParams.delete('sign');
  // Keep secret out of the final request URL if user pasted it into query.
  parsed.searchParams.delete('secret');
  parsed.searchParams.delete('sec');
  parsed.searchParams.delete('webhook_secret');

  const timestamp = String(nowMs);
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = createHmac('sha256', secret)
    .update(stringToSign)
    .digest('base64');
  parsed.searchParams.set('timestamp', timestamp);
  parsed.searchParams.set('sign', sign);
  return parsed.toString();
}

function buildDingTalkText(
  title: string,
  message: string,
  level: 'info' | 'warning' | 'error',
  timeFootnote: string,
): string {
  const maxLength = 1900;
  const raw = `【metapi】[${level.toUpperCase()}] ${title}\n\n${message}\n\n${timeFootnote}`;
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}\n...(truncated)`;
}

/**
 * One-time migration of the legacy single-webhook keys into the channel list.
 *
 * Runs only when `notify_channels` is absent, so it is idempotent and never
 * overwrites a list the user has since edited. The legacy keys are left in
 * place: they cost nothing and keep a rollback path open.
 *
 * Bark is gone as a feature; a Bark URL that merely duplicated the webhook URL
 * (the common misconfiguration) is treated as the intent to keep that channel
 * enabled, while a genuine Bark endpoint is dropped.
 */
export async function migrateLegacyNotifyChannels(): Promise<{ migrated: boolean; channels: number }> {
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .all();
  const settingsMap = new Map<string, string>();
  for (const row of rows) settingsMap.set(row.key, row.value);
  if (settingsMap.has('notify_channels')) {
    return { migrated: false, channels: config.notifyChannels.length };
  }

  const readString = (key: string, fallback: string): string => {
    const raw = settingsMap.get(key);
    if (typeof raw !== 'string') return fallback;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'string' ? parsed : fallback;
    } catch {
      return fallback;
    }
  };
  const readBoolean = (key: string, fallback: boolean): boolean => {
    const raw = settingsMap.get(key);
    if (typeof raw !== 'string') return fallback;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'boolean' ? parsed : fallback;
    } catch {
      return fallback;
    }
  };

  const webhookUrl = readString('webhook_url', String(config.webhookUrl || '')).trim();
  const webhookSecret = readString('webhook_secret', String(config.webhookSecret || '')).trim();
  const webhookEnabled = readBoolean('webhook_enabled', config.webhookEnabled !== false);
  const barkUrl = readString('bark_url', '').trim();
  const barkEnabled = readBoolean('bark_enabled', false);

  const channels: NotifyChannel[] = [];
  if (webhookUrl) {
    channels.push({
      id: 'legacy-1',
      url: webhookUrl,
      secret: webhookSecret,
      enabled: webhookEnabled || (barkEnabled && barkUrl === webhookUrl),
      kind: resolveNotifyChannelKind(webhookUrl),
    });
  }

  await upsertSetting('notify_channels', channels);
  config.notifyChannels = channels;
  return { migrated: true, channels: channels.length };
}

export async function sendNotification(
  title: string,
  message: string,
  level: 'info' | 'warning' | 'error' = 'info',
  options: SendNotificationOptions = {},
): Promise<NotificationDispatchResult> {
  const now = new Date();
  const timeFootnote = buildTimeFootnote(now);
  const { bypassThrottle = false, requireChannel = false, throwOnFailure = false } = options;
  const timeoutMs = normalizeNotificationTimeoutMs(options.timeoutMs);
  const cooldownMs = Math.max(0, Math.trunc(config.notifyCooldownSec)) * 1000;
  let resolvedMessage = message;
  if (!bypassThrottle && cooldownMs > 0) {
    const nowMs = Date.now();
    pruneNotificationThrottleState(notificationThrottleState, nowMs, Math.max(cooldownMs * 6, 600_000));
    const signature = createNotificationSignature(title, message, level);
    const decision = evaluateNotificationThrottle(notificationThrottleState, signature, nowMs, cooldownMs);
    if (!decision.shouldSend) {
      return {
        throttled: true,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        failedChannels: [],
      };
    }
    if (decision.mergedCount > 0) {
      resolvedMessage = `${message}\n\n[通知合并] 冷静期内已合并 ${decision.mergedCount} 条重复告警`;
    }
  }

  const tasks: Array<{ channel: NotificationChannel; channelLabel?: string; run: (signal: AbortSignal) => Promise<unknown> }> = [];

  for (const channel of config.notifyChannels) {
    if (!channel.enabled || !String(channel.url || '').trim()) continue;
    const channelUrl = String(channel.url).trim();
    const channelSecret = String(channel.secret || '').trim();
    // An explicit platform choice wins; otherwise the URL decides.
    const channelKind = channel.kind && channel.kind !== 'custom'
      ? channel.kind
      : resolveNotifyChannelKind(channelUrl);
    const channelLabel = String(channel.label || '').trim() || NOTIFY_CHANNEL_LABELS[channelKind];
    tasks.push(
      {
        channel: 'webhook',
        channelLabel,
        run: async (signal) => {
          const isWeComWebhook = channelKind === 'wecom';
          const isFeishuWebhook = channelKind === 'feishu';
          const isDingTalkWebhook = channelKind === 'dingtalk';
          let body: string;
          if (isWeComWebhook) {
            body = JSON.stringify({
              msgtype: 'text',
              text: {
                content: buildWeComText(title, resolvedMessage, level, timeFootnote),
              },
            });
          } else if (isFeishuWebhook) {
            const feishuPayload: Record<string, unknown> = {
              msg_type: 'text',
              content: {
                text: buildFeishuText(title, resolvedMessage, level, timeFootnote),
              },
            };
            const feishuSecret = extractWebhookSigningSecret(channelUrl, channelSecret);
            body = JSON.stringify(
              feishuSecret ? signFeishuBody(feishuPayload, feishuSecret, now.getTime()) : feishuPayload,
            );
          } else if (isDingTalkWebhook) {
            body = JSON.stringify({
              msgtype: 'text',
              text: {
                content: buildDingTalkText(title, resolvedMessage, level, timeFootnote),
              },
            });
          } else {
            body = JSON.stringify({
              title,
              message: resolvedMessage,
              level,
              timestamp: now.toISOString(),
              localTime: formatLocalDateTime(now),
              timeZone: getResolvedTimeZone(),
            });
          }

          let targetUrl = channelUrl;
          if (isDingTalkWebhook) {
            const secret = extractWebhookSigningSecret(channelUrl, channelSecret);
            if (secret) {
              targetUrl = buildDingTalkSignedUrl(channelUrl, secret, now.getTime());
            }
          }

          const response = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal,
          });
          if (!response.ok) {
            throw new Error(`Webhook 响应状态 ${response.status}`);
          }
          if (isWeComWebhook) {
            let payload: { errcode?: number; errmsg?: string } | null = null;
            try {
              payload = await response.json() as { errcode?: number; errmsg?: string };
            } catch {
              throw new Error('企业微信 Webhook 返回了无效 JSON');
            }
            if (typeof payload?.errcode === 'number' && payload.errcode !== 0) {
              throw new Error(`企业微信 Webhook 返回错误 ${payload.errcode}: ${payload.errmsg || 'unknown error'}`);
            }
          }
          if (isFeishuWebhook) {
            let payload: { code?: number; msg?: string } | null = null;
            try {
              payload = await response.json() as { code?: number; msg?: string };
            } catch {
              throw new Error('飞书 Webhook 返回了无效 JSON');
            }
            if (typeof payload?.code === 'number' && payload.code !== 0) {
              throw new Error(`飞书 Webhook 返回错误 ${payload.code}: ${payload.msg || 'unknown error'}`);
            }
          }
          if (isDingTalkWebhook) {
            let payload: { errcode?: number; errmsg?: string } | null = null;
            try {
              payload = await response.json() as { errcode?: number; errmsg?: string };
            } catch {
              throw new Error('钉钉 Webhook 返回了无效 JSON');
            }
            if (typeof payload?.errcode === 'number' && payload.errcode !== 0) {
              throw new Error(`钉钉 Webhook 返回错误 ${payload.errcode}: ${payload.errmsg || 'unknown error'}`);
            }
          }
        },
      },
    );
  }

  if (config.serverChanEnabled && config.serverChanKey) {
    const form = new URLSearchParams({
      title,
      desp: `${resolvedMessage}\n\nLevel: ${level}\n${timeFootnote}`,
    });
    tasks.push(
      {
        channel: 'serverchan',
        run: async (signal) => {
          const response = await fetch(`https://sctapi.ftqq.com/${config.serverChanKey}.send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
            signal,
          });
          if (!response.ok) {
            throw new Error(`Server酱响应状态 ${response.status}`);
          }
        },
      },
    );
  }

  if (config.telegramEnabled && config.telegramBotToken && config.telegramChatId) {
    const telegramApiBaseUrl = String(config.telegramApiBaseUrl || 'https://api.telegram.org').replace(/\/+$/, '');
    const telegramApiUrl = `${telegramApiBaseUrl}/bot${config.telegramBotToken}/sendMessage`;
    const text = buildTelegramText(title, resolvedMessage, level, timeFootnote);
    const telegramMessageThreadId = Number.parseInt(String(config.telegramMessageThreadId || '').trim(), 10);
    tasks.push({
      channel: 'telegram',
      run: async (signal) => {
        const telegramRequestInit = withExplicitProxyRequestInit(
          null,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: config.telegramChatId,
              ...(Number.isFinite(telegramMessageThreadId) && telegramMessageThreadId > 0
                ? { message_thread_id: telegramMessageThreadId }
                : {}),
              text,
              disable_web_page_preview: true,
            }),
            signal,
          },
        );
        const response = await fetch(telegramApiUrl, telegramRequestInit);
        if (!response.ok) {
          throw new Error(`Telegram 响应状态 ${response.status}`);
        }
        let payload: { ok?: boolean; description?: string } | null = null;
        try {
          payload = await response.json() as { ok?: boolean; description?: string };
        } catch {}
        if (payload?.ok === false) {
          throw new Error(payload.description || 'Telegram 返回失败');
        }
      },
    });
  }

  if (
    config.smtpEnabled &&
    config.smtpHost &&
    config.smtpPort > 0 &&
    config.smtpFrom &&
    config.smtpTo
  ) {
    const transporter = getSmtpTransporter();
    tasks.push(
      {
        channel: 'smtp',
        run: () => transporter.sendMail({
          from: config.smtpFrom,
          to: config.smtpTo,
          subject: `[metapi][${level.toUpperCase()}] ${title}`,
          text: `${resolvedMessage}\n\nLevel: ${level}\n${timeFootnote}`,
        }),
      },
    );
  }

  if (tasks.length === 0) {
    if (requireChannel || throwOnFailure) {
      throw new Error('未启用任何通知渠道，请先开启并保存至少一种通知方式');
    }
    return {
      throttled: false,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      failedChannels: [],
    };
  }

  const results = await Promise.all(tasks.map(async (task) => {
    try {
      await withNotificationTimeout(task.channel, timeoutMs, task.run);
      return { channel: task.channel, ok: true as const, error: '' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const label = task.channelLabel ? `${task.channelLabel}：` : '';
      return {
        channel: task.channel,
        ok: false as const,
        error: `${label}${errorMessage || String(error) || 'unknown error'}`,
      };
    }
  }));

  const failedResults = results.filter((item) => !item.ok);
  const succeeded = results.length - failedResults.length;
  const failedChannels = failedResults.map((item) => item.channel);

  if (throwOnFailure && succeeded === 0 && failedResults.length > 0) {
    throw new Error(`通知发送失败：${failedResults[0].error}`);
  }

  return {
    throttled: false,
    attempted: results.length,
    succeeded,
    failed: failedResults.length,
    failedChannels,
  };
}
