import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({
  sendMail: (...args: unknown[]) => sendMailMock(...args),
}));
const fetchMock = vi.fn();

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (...args: unknown[]) => (createTransportMock as any)(...args),
  },
  createTransport: (...args: unknown[]) => (createTransportMock as any)(...args),
}));

vi.mock('undici', () => ({
  Agent: class MockUndiciAgent {
    constructor(..._args: unknown[]) {}
  },
  setGlobalDispatcher: () => {},

  fetch: (...args: unknown[]) => fetchMock(...args),
}));

const withExplicitProxyRequestInitMock = vi.fn(
  (_proxyUrl: unknown, options?: Record<string, unknown>) => {
    if (_proxyUrl) return { ...(options || {}), dispatcher: 'mock-proxy-dispatcher' };
    return options ?? {};
  },
);

vi.mock('./siteProxy.js', () => ({
  withExplicitProxyRequestInit: (...args: unknown[]) => withExplicitProxyRequestInitMock(...(args as Parameters<typeof withExplicitProxyRequestInitMock>)),
}));

describe('notifyService', () => {
  beforeEach(async () => {
    vi.resetModules();
    sendMailMock.mockReset();
    createTransportMock.mockClear();
    fetchMock.mockReset();
    withExplicitProxyRequestInitMock.mockClear();

    const { config } = await import('../config.js');
    config.notifyCooldownSec = 300;
    config.webhookEnabled = false;
    config.webhookUrl = '';
    config.notifyChannels = config.notifyChannels.map((c) => ({ ...c, secret: '' }));
    config.notifyChannels = [];
    config.serverChanEnabled = false;
    config.serverChanKey = '';
    (config as any).telegramEnabled = false;
    (config as any).telegramBotToken = '';
    (config as any).telegramChatId = '';
    (config as any).telegramMessageThreadId = '';
    config.smtpEnabled = true;
    config.smtpHost = 'smtp.example.com';
    config.smtpPort = 465;
    config.smtpSecure = true;
    config.smtpUser = 'demo-user';
    config.smtpPass = 'demo-pass';
    config.smtpFrom = 'sender@example.com';
    config.smtpTo = 'receiver@example.com';
  });

  it('bypasses cooldown when bypassThrottle is enabled', async () => {
    sendMailMock.mockResolvedValue({ accepted: ['receiver@example.com'] });
    const { sendNotification } = await import('./notifyService.js');

    await (sendNotification as any)('测试通知', 'same-message', 'info', { bypassThrottle: true });
    await (sendNotification as any)('测试通知', 'same-message', 'info', { bypassThrottle: true });

    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it('throws when strict delivery is required and no channels are enabled', async () => {
    const { config } = await import('../config.js');
    config.smtpEnabled = false;

    const { sendNotification } = await import('./notifyService.js');
    await expect(
      (sendNotification as any)('测试通知', 'message', 'info', {
        requireChannel: true,
        throwOnFailure: true,
      }),
    ).rejects.toThrow('未启用任何通知渠道');
  });

  it('throws when strict delivery is required and all channel sends fail', async () => {
    sendMailMock.mockRejectedValue(new Error('smtp auth failed'));
    const { sendNotification } = await import('./notifyService.js');

    await expect(
      (sendNotification as any)('测试通知', 'message', 'info', {
        bypassThrottle: true,
        throwOnFailure: true,
      }),
    ).rejects.toThrow(/smtp auth failed|通知发送失败/);
  });

  it('includes failed channel details when all enabled channels fail', async () => {
    const { config } = await import('../config.js');
    config.notifyChannels = [{ id: 'test-1', url: 'https://webhook.example.com/notify', secret: '', enabled: true }];
    config.notifyChannels = [
      { id: 'test-1', url: 'https://webhook.example.com/notify', secret: '', enabled: true },
      { id: 'test-2', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/second', secret: '', enabled: true },
    ];
    config.smtpEnabled = false;

    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      });

    const { sendNotification } = await import('./notifyService.js');

    await expect(
      (sendNotification as any)('测试通知', 'message', 'info', {
        bypassThrottle: true,
        throwOnFailure: true,
      }),
    ).rejects.toThrow(/Webhook 响应状态/i);
  });

  it('times out a stalled channel without blocking successful channels', async () => {
    vi.useFakeTimers();
    try {
      const { config } = await import('../config.js');
      config.notifyChannels = [{ id: 'test-1', url: 'https://webhook.example.com/notify', secret: '', enabled: true }];
      config.smtpEnabled = true;
      fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
      sendMailMock.mockResolvedValue({ accepted: ['receiver@example.com'] });

      const { sendNotification } = await import('./notifyService.js');
      const pending = sendNotification('测试通知', 'message', 'info', {
        bypassThrottle: true,
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toMatchObject({
        attempted: 2,
        succeeded: 1,
        failed: 1,
        failedChannels: ['webhook'],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out stalled smtp delivery and reports strict failure', async () => {
    vi.useFakeTimers();
    try {
      sendMailMock.mockImplementation(() => new Promise(() => {}));
      const { sendNotification } = await import('./notifyService.js');
      const pending = sendNotification('测试通知', 'message', 'info', {
        bypassThrottle: true,
        throwOnFailure: true,
        timeoutMs: 50,
      });
      const rejection = expect(pending).rejects.toThrow(/timeout|超时|通知发送失败/i);
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends enterprise wechat webhook payload as structured text message', async () => {
    const { config } = await import('../config.js');
    config.notifyChannels = [{ id: 'test-1', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo-key', secret: '', enabled: true }];
    config.smtpEnabled = false;

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ errcode: 0, errmsg: 'ok' }),
    });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('测试通知', 'message', 'info', { bypassThrottle: true, throwOnFailure: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, { body?: string }];
    expect(call[0]).toContain('qyapi.weixin.qq.com/cgi-bin/webhook/send');

    const payload = JSON.parse(call[1]?.body || '{}') as { msgtype?: string; markdown?: { content?: string } };
    expect(Array.isArray(payload)).toBe(false);
    // 企业微信只有 markdown / markdown_v2 类型才渲染 markdown，text 是纯文本。
    expect(payload.msgtype).toBe('markdown');
    expect(payload.markdown?.content || '').toContain('[metapi][INFO] 测试通知');
    expect(payload.markdown?.content || '').toContain('message');
    // 官方上限是 4096 字节（不是字符），必须按字节截断。
    expect(Buffer.byteLength(payload.markdown?.content || '', 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('fails when enterprise wechat webhook returns non-zero errcode', async () => {
    const { config } = await import('../config.js');
    config.notifyChannels = [{ id: 'test-1', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo-key', secret: '', enabled: true }];
    config.smtpEnabled = false;

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ errcode: 93000, errmsg: 'invalid json' }),
    });

    const { sendNotification } = await import('./notifyService.js');
    await expect(
      sendNotification('测试通知', 'message', 'info', {
        bypassThrottle: true,
        throwOnFailure: true,
      }),
    ).rejects.toThrow(/企业微信|93000|invalid json/);
  });

  it('includes local time and utc time labels in smtp payload', async () => {
    sendMailMock.mockResolvedValue({ accepted: ['receiver@example.com'] });
    const { sendNotification } = await import('./notifyService.js');

    await sendNotification('测试通知', 'message', 'info', { bypassThrottle: true });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const payload = sendMailMock.mock.calls[0]?.[0] as { text?: string };
    expect(payload?.text || '').toContain('时间:');
    expect(payload?.text || '').not.toContain('UTC Time:');
  });

  it('sends telegram message without topic when telegram thread id is empty', async () => {
    const { config } = await import('../config.js');
    (config as any).telegramEnabled = true;
    (config as any).telegramBotToken = '123456:telegram-token';
    (config as any).telegramChatId = '-1001234567890';
    (config as any).telegramMessageThreadId = '';
    config.smtpEnabled = false;

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('测试通知', 'message', 'warning', { bypassThrottle: true, throwOnFailure: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:telegram-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const rawBody = fetchMock.mock.calls[0]?.[1] as { body?: string };
    const payload = JSON.parse(rawBody?.body || '{}') as { chat_id?: string; text?: string; message_thread_id?: number };
    expect(payload.chat_id).toBe('-1001234567890');
    expect(payload.message_thread_id).toBeUndefined();
    expect(payload.text || '').toContain('Level: warning');
    expect(payload.text || '').toContain('时间:');
    expect(payload.text || '').not.toContain('UTC Time:');
  });

  it('sends telegram topic id when telegram thread id is configured', async () => {
    const { config } = await import('../config.js');
    (config as any).telegramEnabled = true;
    (config as any).telegramBotToken = '123456:telegram-token';
    (config as any).telegramChatId = '-1001234567890';
    (config as any).telegramMessageThreadId = '77';
    config.smtpEnabled = false;

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('测试通知', 'message', 'warning', { bypassThrottle: true, throwOnFailure: true });

    const rawBody = fetchMock.mock.calls[0]?.[1] as { body?: string };
    const payload = JSON.parse(rawBody?.body || '{}') as { message_thread_id?: number };
    expect(payload.message_thread_id).toBe(77);
  });

  it('uses TELEGRAM_API_BASE_URL when configured', async () => {
    const { config } = await import('../config.js');
    (config as any).telegramEnabled = true;
    (config as any).telegramBotToken = '123456:telegram-token';
    (config as any).telegramChatId = '-1001234567890';
    (config as any).telegramApiBaseUrl = 'https://tg-proxy.example.com/custom/';
    config.smtpEnabled = false;

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('测试通知', 'message', 'warning', { bypassThrottle: true, throwOnFailure: true });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://tg-proxy.example.com/custom/bot123456:telegram-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('sends feishu webhook payload with msg_type text format', async () => {
    const { config } = await import('../config.js');
    config.notifyChannels = [{ id: 'test-1', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-token', secret: '', enabled: true }];
    config.smtpEnabled = false;

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ code: 0, msg: 'success' }),
    });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('测试通知', 'feishu message', 'info', { bypassThrottle: true, throwOnFailure: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, { body?: string }];
    expect(call[0]).toContain('open.feishu.cn/open-apis/bot/v2/hook/');

    const payload = JSON.parse(call[1]?.body || '{}') as {
      msg_type?: string;
      card?: {
        schema?: string;
        header?: { title?: { content?: string }; template?: string };
        body?: { elements?: Array<{ tag?: string; content?: string }> };
      };
    };
    // 飞书自定义机器人只有消息卡片（interactive）能渲染 markdown；text / post 都不是 markdown。
    expect(payload.msg_type).toBe('interactive');
    expect(payload.card?.schema).toBe('2.0');
    expect(payload.card?.header?.title?.content || '').toContain('测试通知');
    // 品牌色：飞书无自定义色值，info 用最接近 metapi teal 的 turquoise（#067062）。
    expect(payload.card?.header?.template).toBe('turquoise');
    const md = (payload.card?.body?.elements || []).filter((e) => e?.tag === 'markdown');
    expect(md.length).toBeGreaterThan(0);
    const joined = md.map((e) => e.content || '').join('\n');
    expect(joined).toContain('feishu message');
    expect(joined).toContain('[metapi][INFO]');
    // 官方上限：请求体 20KB。
    expect(Buffer.byteLength(call[1]?.body || '', 'utf8')).toBeLessThan(20000);
  });

  it('signs the feishu body when a signature secret is configured', async () => {
    const { config } = await import('../config.js');
    const { createHmac } = await import('node:crypto');
    const secret = 'feishu-sign-secret-demo';
    config.notifyChannels = [{ id: 'test-1', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-token', secret: '', enabled: true }];
    config.notifyChannels = config.notifyChannels.map((c) => ({ ...c, secret: secret }));
    config.smtpEnabled = false;

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ code: 0, msg: 'success' }),
    });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('测试通知', 'feishu message', 'info', { bypassThrottle: true, throwOnFailure: true });

    const call = fetchMock.mock.calls[0] as [string, { body?: string }];
    const payload = JSON.parse(call[1]?.body || '{}') as {
      msg_type?: string;
      timestamp?: string;
      sign?: string;
    };
    // Feishu 签名校验签的是请求体：timestamp 为 epoch 秒，sign =
    // base64(HMAC-SHA256(key = `${timestamp}\n${secret}`, message = ""))。
    expect(payload.msg_type).toBe('interactive');
    expect(payload.timestamp).toMatch(/^\d{9,}$/);
    const stringToSign = `${payload.timestamp}\n${secret}`;
    const expected = createHmac('sha256', stringToSign).update('').digest('base64');
    expect(payload.sign).toBe(expected);
  });

  it('fails when feishu webhook returns non-zero code', async () => {
    const { config } = await import('../config.js');
    config.notifyChannels = [{ id: 'test-1', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-token', secret: '', enabled: true }];
    config.smtpEnabled = false;

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ code: 19001, msg: 'param invalid' }),
    });

    const { sendNotification } = await import('./notifyService.js');
    await expect(
      sendNotification('测试通知', 'message', 'info', {
        bypassThrottle: true,
        throwOnFailure: true,
      }),
    ).rejects.toThrow(/飞书|19001|param invalid/);
  });

  it('sends feishu webhook payload for larksuite.com domain', async () => {
    const { config } = await import('../config.js');
    config.notifyChannels = [{ id: 'test-1', url: 'https://open.larksuite.com/open-apis/bot/v2/hook/demo-token', secret: '', enabled: true }];
    config.smtpEnabled = false;

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ code: 0, msg: 'success' }),
    });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('测试通知', 'lark message', 'warning', { bypassThrottle: true, throwOnFailure: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, { body?: string }];
    expect(call[0]).toContain('open.larksuite.com/open-apis/bot/v2/hook/');

    const payload = JSON.parse(call[1]?.body || '{}') as {
      msg_type?: string;
      card?: { header?: { template?: string; title?: { content?: string } }; body?: { elements?: Array<{ tag?: string; content?: string }> } };
    };
    expect(payload.msg_type).toBe('interactive');
    expect(payload.card?.header?.template).toBe('orange');
    expect(payload.card?.header?.title?.content || '').toContain('测试通知');
    const joined = (payload.card?.body?.elements || []).filter((e) => e?.tag === 'markdown').map((e) => e.content || '').join('\n');
    expect(joined).toContain('lark message');
    expect(joined).toContain('[metapi][WARNING]');
  });

  it('sends dingtalk text payload and signs url when secret is configured', async () => {
    const { config } = await import('../config.js');
    config.notifyChannels = [{ id: 'test-1', url: 'https://oapi.dingtalk.com/robot/send?access_token=demo-token', secret: '', enabled: true }];
    config.notifyChannels = config.notifyChannels.map((c) => ({ ...c, secret: 'SECdemo' }));
    config.smtpEnabled = false;
    config.serverChanEnabled = false;
    (config as any).telegramEnabled = false;

    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: 'ok' }),
    });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('测试通知', 'dingtalk message', 'info', { bypassThrottle: true, throwOnFailure: true });

    const dingtalkCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('oapi.dingtalk.com'));
    expect(dingtalkCalls.length).toBe(1);
    const [url, init] = dingtalkCalls[0];
    expect(String(url)).toContain('https://oapi.dingtalk.com/robot/send?access_token=demo-token');
    expect(String(url)).toContain('timestamp=');
    expect(String(url)).toContain('sign=');
    expect(String(url)).not.toContain('secret=');
    const body = JSON.parse(String((init as any).body));
    // 钉钉 markdown 类型：title 必填（首屏透出），text 才是 markdown 正文。
    expect(body.msgtype).toBe('markdown');
    expect(body.markdown.title).toBe('测试通知');
    expect(body.markdown.text).toContain('测试通知');
    expect(body.markdown.text).toContain('dingtalk message');
    expect(body.markdown.text).toContain('[metapi][INFO]');
  });

  it('fails when dingtalk webhook returns non-zero errcode', async () => {
    const { config } = await import('../config.js');
    config.notifyChannels = [{ id: 'test-1', url: 'https://oapi.dingtalk.com/robot/send?access_token=demo-token', secret: '', enabled: true }];
    config.notifyChannels = config.notifyChannels.map((c) => ({ ...c, secret: '' }));
    config.smtpEnabled = false;
    config.serverChanEnabled = false;
    (config as any).telegramEnabled = false;

    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ errcode: 310000, errmsg: 'sign not match' }),
    });

    const { sendNotification } = await import('./notifyService.js');
    await expect(
      sendNotification('测试通知', 'message', 'info', {
        bypassThrottle: true,
        throwOnFailure: true,
      }),
    ).rejects.toThrow(/钉钉|310000|sign not match/i);
  });
  it('passes markdown bodies through verbatim so site announcements render', async () => {
    const { config } = await import('../config.js');
    config.notifyChannels = [{ id: 'test-1', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-token', secret: '', enabled: true }];
    config.smtpEnabled = false;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) });

    const { sendNotification } = await import('./notifyService.js');
    const announcement = '# 欢迎使用 liWAN公益站\n\n## 日常开发\n**加粗重点**\n1. 第一条\n2. 第二条';
    await sendNotification('站点公告：liWAN LAB', announcement, 'info', { bypassThrottle: true, throwOnFailure: true });

    const call = fetchMock.mock.calls[0] as [string, { body?: string }];
    const payload = JSON.parse(call[1]?.body || '{}') as { card?: { body?: { elements?: Array<{ tag?: string; content?: string }> } } };
    const joined = (payload.card?.body?.elements || []).map((e) => e.content || '').join('\n');
    expect(joined).toContain('# 欢迎使用 liWAN公益站');
    expect(joined).toContain('**加粗重点**');
    expect(joined).toContain('1. 第一条');
  });

  it('truncates enterprise wechat markdown by utf-8 bytes, not by characters', async () => {
    const { config } = await import('../config.js');
    config.notifyChannels = [{ id: 'test-1', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo-key', secret: '', enabled: true }];
    config.smtpEnabled = false;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ errcode: 0 }) });

    const { sendNotification } = await import('./notifyService.js');
    // 2000 个汉字 = 6000 字节，远超 4096 字节上限。
    await sendNotification('长公告', '汉'.repeat(2000), 'info', { bypassThrottle: true, throwOnFailure: true });

    const call = fetchMock.mock.calls[0] as [string, { body?: string }];
    const payload = JSON.parse(call[1]?.body || '{}') as { markdown?: { content?: string } };
    const bytes = Buffer.byteLength(payload.markdown?.content || '', 'utf8');
    expect(bytes).toBeLessThanOrEqual(4096);
    expect(bytes).toBeGreaterThan(3000);
    expect(payload.markdown?.content || '').toContain('truncated');
  });

  it('keeps the feishu card request body under the 20KB limit for huge announcements', async () => {
    const { config } = await import('../config.js');
    config.notifyChannels = [{ id: 'test-1', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-token', secret: '', enabled: true }];
    config.smtpEnabled = false;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) });

    const { sendNotification } = await import('./notifyService.js');
    // 生产库最长的一条站点公告是 24143 字节正文，已超飞书 20KB 请求体上限。
    await sendNotification('站点公告：JustDoWork', '汉'.repeat(9000), 'info', { bypassThrottle: true, throwOnFailure: true });

    const call = fetchMock.mock.calls[0] as [string, { body?: string }];
    expect(Buffer.byteLength(call[1]?.body || '', 'utf8')).toBeLessThan(20000);
    const payload = JSON.parse(call[1]?.body || '{}') as { card?: { body?: { elements?: Array<{ content?: string }> } } };
    const joined = (payload.card?.body?.elements || []).map((e) => e.content || '').join('\n');
    expect(joined).toContain('truncated');
  });
});
