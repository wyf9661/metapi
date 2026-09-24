import React, { useEffect, useState } from 'react';
import { api, type RuntimeSettingsPayload } from '../api.js';
import { useToast } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import { tr } from '../i18n.js';
import { useIsMobile } from '../components/useIsMobile.js';

type NotifyChannelKind = 'dingtalk' | 'feishu' | 'wecom' | 'custom';

type NotifyChannelRow = {
    id: string;
    kind: NotifyChannelKind;
    url: string;
    /** Only carries a new value the user typed; empty means "keep the saved one". */
    secret: string;
    secretMasked?: string;
    enabled: boolean;
    label?: string;
};

const NOTIFY_KIND_OPTIONS = [
    { value: 'dingtalk', label: '钉钉' },
    { value: 'feishu', label: '飞书' },
    { value: 'wecom', label: '企业微信' },
    { value: 'custom', label: '自定义' },
];

/** Mirrors the server-side host detection so a pasted URL preselects the platform. */
function detectChannelKind(url: string): NotifyChannelKind {
    try {
        const { hostname, pathname } = new URL(url.trim());
        if (hostname === 'qyapi.weixin.qq.com' && pathname.includes('/cgi-bin/webhook/send')) return 'wecom';
        if ((hostname === 'open.feishu.cn' || hostname === 'open.larksuite.com') && pathname.includes('/bot/v2/hook/')) return 'feishu';
        if (hostname === 'oapi.dingtalk.com' && pathname.includes('/robot/send')) return 'dingtalk';
    } catch { /* keep the current choice while the URL is half-typed */ }
    return 'custom';
}

const CHANNEL_URL_PLACEHOLDER: Record<NotifyChannelKind, string> = {
    dingtalk: 'https://oapi.dingtalk.com/robot/send?access_token=...',
    feishu: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
    wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
    custom: 'https://example.com/webhook',
};

type RuntimeSettings = {
    notifyChannels: NotifyChannelRow[];
    webhookUrl: string;
    webhookSecret: string;
    webhookEnabled: boolean;
    serverChanEnabled: boolean;
    telegramEnabled: boolean;
    telegramApiBaseUrl: string;
    telegramChatId: string;
    telegramMessageThreadId: string;
    smtpEnabled: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    smtpPassMasked?: string;
    smtpFrom: string;
    smtpTo: string;
    serverChanKeyMasked?: string;
    telegramBotTokenMasked?: string;
    notifyCooldownSec: number;
};

export default function NotificationSettings() {
    const isMobile = useIsMobile();
    const [runtime, setRuntime] = useState<RuntimeSettings>({
        notifyChannels: [],
        webhookUrl: '',
        webhookSecret: '',
        webhookEnabled: true,
        serverChanEnabled: false,
        telegramEnabled: false,
        telegramApiBaseUrl: 'https://api.telegram.org',
        telegramChatId: '',
        telegramMessageThreadId: '',
        smtpEnabled: false,
        smtpHost: '',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: '',
        smtpFrom: '',
        smtpTo: '',
        notifyCooldownSec: 300,
    });

    const [serverChanKey, setServerChanKey] = useState('');
    const [telegramBotToken, setTelegramBotToken] = useState('');
    const [smtpPass, setSmtpPass] = useState('');
    const [loading, setLoading] = useState(true);
    const [savingNotify, setSavingNotify] = useState(false);
    const [testingNotify, setTestingNotify] = useState(false);
    const toast = useToast();

    const inputStyle: React.CSSProperties = {
        width: '100%',
        padding: '10px 14px',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 13,
        outline: 'none',
        background: 'var(--color-bg)',
        color: 'var(--color-text-primary)',
        transition: 'border-color 0.2s',
    };

    const loadSettings = async () => {
        setLoading(true);
        try {
            const runtimeInfo = await api.getRuntimeSettings();
            setRuntime({
                notifyChannels: (() => {
                    const rows = (runtimeInfo.notifyChannels || []).map((ch: {
                        id: string;
                        url: string;
                        secret?: string;
                        enabled?: boolean;
                        label?: string;
                        kind?: NotifyChannelKind;
                    }) => ({
                        id: ch.id,
                        kind: (ch as { kind?: NotifyChannelKind }).kind
                            || detectChannelKind(ch.url || ''),
                        url: ch.url || '',
                        secret: '',
                        secretMasked: ch.secret || '',
                        enabled: ch.enabled !== false,
                        label: ch.label,
                    }));
                    if (rows.length > 0) return rows;
                    // Pre-migration payload: surface the legacy single webhook as one row.
                    if (runtimeInfo.webhookUrl) {
                        return [{
                            id: 'legacy-1',
                            kind: detectChannelKind(runtimeInfo.webhookUrl),
                            url: runtimeInfo.webhookUrl,
                            secret: '',
                            secretMasked: (runtimeInfo as any).webhookSecret || '',
                            enabled: runtimeInfo.webhookEnabled !== false,
                        }];
                    }
                    return [];
                })(),
                webhookUrl: runtimeInfo.webhookUrl || '',
                webhookSecret: (runtimeInfo as any).webhookSecret || '',
                webhookEnabled: runtimeInfo.webhookEnabled ?? true,
                serverChanEnabled: !!runtimeInfo.serverChanEnabled,
                telegramEnabled: !!runtimeInfo.telegramEnabled,
                telegramApiBaseUrl: runtimeInfo.telegramApiBaseUrl || 'https://api.telegram.org',
                telegramChatId: runtimeInfo.telegramChatId || '',
                telegramMessageThreadId: runtimeInfo.telegramMessageThreadId || '',
                smtpEnabled: !!runtimeInfo.smtpEnabled,
                smtpHost: runtimeInfo.smtpHost || '',
                smtpPort: Number(runtimeInfo.smtpPort) || 587,
                smtpSecure: !!runtimeInfo.smtpSecure,
                smtpUser: runtimeInfo.smtpUser || '',
                smtpPassMasked: runtimeInfo.smtpPassMasked || '',
                smtpFrom: runtimeInfo.smtpFrom || '',
                smtpTo: runtimeInfo.smtpTo || '',
                serverChanKeyMasked: runtimeInfo.serverChanKeyMasked || '',
                telegramBotTokenMasked: runtimeInfo.telegramBotTokenMasked || '',
                notifyCooldownSec: Number.isFinite(Number(runtimeInfo.notifyCooldownSec))
                    ? Math.max(0, Math.trunc(Number(runtimeInfo.notifyCooldownSec)))
                    : 300,
            });
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
            toast.error(errMessage || '加载通知设置失败');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadSettings();
    }, []);

    const updateChannel = (id: string, patch: Partial<NotifyChannelRow>) => {
        setRuntime((prev) => ({
            ...prev,
            notifyChannels: prev.notifyChannels.map((row) => (row.id === id ? { ...row, ...patch } : row)),
        }));
    };

    const addChannel = () => {
        setRuntime((prev) => ({
            ...prev,
            notifyChannels: [
                ...prev.notifyChannels,
                { id: `ch-${Date.now().toString(36)}-${prev.notifyChannels.length}`, kind: 'dingtalk', url: '', secret: '', enabled: true },
            ],
        }));
    };

    const removeChannel = (id: string) => {
        setRuntime((prev) => ({ ...prev, notifyChannels: prev.notifyChannels.filter((row) => row.id !== id) }));
    };

    const saveNotify = async () => {
        setSavingNotify(true);
        try {
            const payload: RuntimeSettingsPayload = {
                notifyChannels: runtime.notifyChannels.map((row) => ({
                    id: row.id,
                    kind: row.kind,
                    url: row.url,
                    secret: row.secret,
                    enabled: row.enabled,
                    label: row.label,
                })),
                serverChanEnabled: runtime.serverChanEnabled,
                telegramEnabled: runtime.telegramEnabled,
                telegramApiBaseUrl: runtime.telegramApiBaseUrl,
                telegramChatId: runtime.telegramChatId,
                telegramMessageThreadId: runtime.telegramMessageThreadId,
                smtpEnabled: runtime.smtpEnabled,
                smtpHost: runtime.smtpHost,
                smtpPort: runtime.smtpPort,
                smtpSecure: runtime.smtpSecure,
                smtpUser: runtime.smtpUser,
                smtpFrom: runtime.smtpFrom,
                smtpTo: runtime.smtpTo,
                notifyCooldownSec: Math.max(0, Math.trunc(Number(runtime.notifyCooldownSec) || 0)),
            };
            if (serverChanKey.trim()) payload.serverChanKey = serverChanKey.trim();
            if (telegramBotToken.trim()) payload.telegramBotToken = telegramBotToken.trim();
            if (smtpPass.trim()) payload.smtpPass = smtpPass.trim();

            const res = await api.updateRuntimeSettings(payload);
            setRuntime((prev) => ({
                ...prev,
                serverChanKeyMasked: res.serverChanKeyMasked || prev.serverChanKeyMasked,
                telegramBotTokenMasked: res.telegramBotTokenMasked || prev.telegramBotTokenMasked,
                smtpPassMasked: res.smtpPassMasked || prev.smtpPassMasked,
            }));
            setServerChanKey('');
            setTelegramBotToken('');
            setSmtpPass('');
            toast.success('通知设置已保存');
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
            toast.error(errMessage || '保存失败');
        } finally {
            setSavingNotify(false);
        }
    };

    const testNotify = async () => {
        setTestingNotify(true);
        try {
            const res = await api.testNotification();
            toast.success(res?.message || '测试通知已发送');
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
            toast.error(errMessage || '触发测试通知失败');
        } finally {
            setTestingNotify(false);
        }
    };

    if (loading) {
        return (
            <div className="animate-fade-in">
                <div className="skeleton" style={{ width: 220, height: 28, marginBottom: 20 }} />
                <div className="skeleton" style={{ width: '100%', height: 320, borderRadius: 'var(--radius-sm)' }} />
            </div>
        );
    }

    return (
        <div className="animate-fade-in" style={{ width: '100%', maxWidth: 1320, margin: '0 auto', paddingBottom: 40 }}>
            {/* 头部标题与操作 */}
            <div className="page-header">
                <h2 className="page-title">{tr('通知设置')}</h2>
                <div className="page-actions">
                    <button onClick={testNotify} disabled={testingNotify} className="btn btn-soft-primary">
                        {testingNotify ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'var(--color-primary)', borderColor: 'color-mix(in srgb, var(--color-primary) 30%, transparent)' }} /> 发送中...</> : '发送测试通知'}
                    </button>
                    <button onClick={saveNotify} disabled={savingNotify} className="btn btn-primary">
                        {savingNotify ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存通知设置'}
                    </button>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 460px), 1fr))', gap: 16 }}>

                <div style={{ gridColumn: '1 / -1', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--color-text-muted)', marginTop: 4 }}>告警策略</div>

                <div className="card animate-slide-up stagger-1" style={{ padding: 20 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>告警去噪与冷静期</div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
                        相同告警在冷静期内不会重复推送；冷静期结束后会自动合并重复条数。
                    </div>
                    <div style={{ maxWidth: 260 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>
                            冷静期（秒）
                        </div>
                        <input
                            type="number"
                            min={0}
                            value={runtime.notifyCooldownSec}
                            onChange={(e) => setRuntime((prev) => ({
                                ...prev,
                                notifyCooldownSec: Math.max(0, Math.trunc(Number(e.target.value) || 0)),
                            }))}
                            style={inputStyle}
                        />
                    </div>
                </div>

                <div style={{ gridColumn: '1 / -1', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--color-text-muted)', marginTop: 4 }}>推送通道</div>

                {/* 卡片：机器人推送（列表，每行一条独立通道） */}
                <div
                    className="card animate-slide-up stagger-2"
                    style={{
                        padding: 24,
                        gridColumn: '1 / -1',
                        border: runtime.notifyChannels.some((row) => row.enabled)
                            ? '1px solid var(--color-primary)'
                            : '1px solid var(--color-border-light)',
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                        <div style={{ width: 32, height: 32, color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" /></svg>
                        </div>
                        <div>
                            <div style={{ fontWeight: 600, fontSize: 15 }}>机器人推送</div>
                            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>钉钉、飞书、企业微信，每条通道独立地址与密钥，可同时启用</div>
                        </div>
                    </div>

                    {runtime.notifyChannels.length === 0 && (
                        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '4px 0 12px' }}>
                            还没有推送通道，点下面的按钮添加一条。
                        </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {runtime.notifyChannels.map((row) => (
                            <div
                                key={row.id}
                                style={{
                                    display: 'flex',
                                    flexDirection: isMobile ? 'column' : 'row',
                                    gap: 10,
                                    alignItems: isMobile ? 'stretch' : 'center',
                                    padding: 12,
                                    border: '1px solid var(--color-border-light)',
                                    borderRadius: 10,
                                    opacity: row.enabled ? 1 : 0.65,
                                    transition: 'opacity 0.2s',
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: isMobile ? 'none' : '0 0 auto' }}>
                                    <div style={{ width: isMobile ? '100%' : 116 }}>
                                        <ModernSelect
                                            size="sm"
                                            value={row.kind}
                                            onChange={(value) => updateChannel(row.id, { kind: value as NotifyChannelKind })}
                                            options={NOTIFY_KIND_OPTIONS}
                                        />
                                    </div>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                        <input
                                            type="checkbox"
                                            style={{ width: 16, height: 16, cursor: 'pointer' }}
                                            checked={row.enabled}
                                            onChange={(e) => updateChannel(row.id, { enabled: e.target.checked })}
                                        />
                                        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>启用</span>
                                    </label>
                                </div>

                                <input
                                    value={row.url}
                                    onChange={(e) => {
                                        const nextUrl = e.target.value;
                                        const detected = detectChannelKind(nextUrl);
                                        updateChannel(row.id, detected === 'custom'
                                            ? { url: nextUrl }
                                            : { url: nextUrl, kind: detected });
                                    }}
                                    placeholder={CHANNEL_URL_PLACEHOLDER[row.kind]}
                                    style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                                />

                                <input
                                    value={row.secret}
                                    onChange={(e) => updateChannel(row.id, { secret: e.target.value })}
                                    placeholder={row.secretMasked ? '已保存密钥，留空不改' : '加签密钥（可选）'}
                                    style={{ ...inputStyle, flex: isMobile ? 1 : '0 0 220px' }}
                                />

                                <button
                                    type="button"
                                    onClick={() => removeChannel(row.id)}
                                    className="btn btn-link btn-link-warning"
                                    style={{ fontSize: 12, flex: isMobile ? 'none' : '0 0 auto' }}
                                >
                                    删除
                                </button>
                            </div>
                        ))}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
                        <button type="button" onClick={addChannel} className="btn btn-soft-primary">添加通道</button>
                        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                            加签密钥：钉钉「加签」与飞书「签名校验」都填这里，留空表示不需要。
                        </span>
                    </div>
                </div>

                {/* 卡片：Server酱 */}
                <div className="card animate-slide-up stagger-3" style={{ padding: 24, border: runtime.serverChanEnabled ? '1px solid var(--color-primary)' : '1px solid var(--color-border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 10, marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, color: 'var(--color-warning)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>Server酱 (SendKey)</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>微信推送消息支持</div>
                            </div>
                        </div>

                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                            <span style={{ fontSize: 13, fontWeight: 500, color: runtime.serverChanEnabled ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>启用 Server酱</span>
                            <input
                                type="checkbox"
                                style={{ width: 16, height: 16, cursor: 'pointer' }}
                                checked={runtime.serverChanEnabled}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, serverChanEnabled: e.target.checked }))}
                            />
                        </label>
                    </div>

                    <div style={{ opacity: runtime.serverChanEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                        <code style={{ display: 'block', padding: '10px 14px', background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-light)', marginBottom: 10 }}>
                            当前配置: {runtime.serverChanKeyMasked || '未设置'}
                        </code>
                        <input
                            type="password"
                            value={serverChanKey}
                            onChange={(e) => setServerChanKey(e.target.value)}
                            placeholder="输入新的 Server酱 Key（留空则不改）"
                            style={inputStyle}
                            disabled={!runtime.serverChanEnabled}
                        />
                    </div>
                </div>

                {/* 卡片：Telegram */} 
                <div className="card animate-slide-up stagger-4" style={{ padding: 24, border: runtime.telegramEnabled ? '1px solid var(--color-primary)' : '1px solid var(--color-border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 10, marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 11l18-8-6 18-3-7-9-3z" /></svg>
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>Telegram Bot</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>通过 Telegram 机器人推送消息通知</div>
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: 16 }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                                <span style={{ fontSize: 13, fontWeight: 500, color: runtime.telegramEnabled ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>启用 Telegram</span>
                                <input
                                    type="checkbox"
                                    style={{ width: 16, height: 16, cursor: 'pointer' }}
                                    checked={runtime.telegramEnabled}
                                    onChange={(e) => setRuntime((prev) => ({ ...prev, telegramEnabled: e.target.checked }))}
                                />
                            </label>
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px 20px', opacity: runtime.telegramEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                        <div style={{ gridColumn: '1 / -1' }}>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Telegram API Base URL</div>
                            <input
                                value={runtime.telegramApiBaseUrl}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, telegramApiBaseUrl: e.target.value }))}
                                placeholder="例如: https://your-proxy.example.com"
                                style={inputStyle}
                                disabled={!runtime.telegramEnabled}
                            />
                            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>
                                留空或使用默认值时直连官方 Telegram API；如需国内反代，可填写反代前缀。
                            </div>
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Telegram Chat ID</div>
                            <input
                                value={runtime.telegramChatId}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, telegramChatId: e.target.value }))}
                                placeholder="例如: -1001234567890 或 @your_channel"
                                style={inputStyle}
                                disabled={!runtime.telegramEnabled}
                            />
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Telegram Topic ID</div>
                            <input
                                value={runtime.telegramMessageThreadId}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, telegramMessageThreadId: e.target.value }))}
                                placeholder="例如: 77"
                                style={inputStyle}
                                disabled={!runtime.telegramEnabled}
                            />
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>
                                Telegram Bot Token
                                {runtime.telegramBotTokenMasked && <span style={{ color: 'var(--color-primary)', marginLeft: 8, fontSize: 12 }}>(当前已设置)</span>}
                            </div>
                            <input
                                type="password"
                                value={telegramBotToken}
                                onChange={(e) => setTelegramBotToken(e.target.value)}
                                placeholder="输入新的 Bot Token（留空则不改）"
                                style={inputStyle}
                                disabled={!runtime.telegramEnabled}
                            />
                        </div>
                    </div>
                </div>

                {/* 卡片：SMTP 邮件设置 */}
                <div className="card animate-slide-up stagger-4" style={{ padding: 24, border: runtime.smtpEnabled ? '1px solid var(--color-primary)' : '1px solid var(--color-border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 10, marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>邮件服务 (SMTP)</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>通过电子邮件推送提醒</div>
                            </div>
                        </div>

                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                            <span style={{ fontSize: 13, fontWeight: 500, color: runtime.smtpEnabled ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>启用 SMTP</span>
                            <input
                                type="checkbox"
                                style={{ width: 16, height: 16, cursor: 'pointer' }}
                                checked={runtime.smtpEnabled}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpEnabled: e.target.checked }))}
                            />
                        </label>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px 20px', opacity: runtime.smtpEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                        {/* Host */}
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>SMTP 服务器</div>
                            <input
                                value={runtime.smtpHost}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpHost: e.target.value }))}
                                placeholder="例如: smtp.qq.com"
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                        {/* Port & Secure */}
                        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>端口</div>
                                <input
                                    type="number"
                                    min={1}
                                    value={runtime.smtpPort}
                                    onChange={(e) => setRuntime((prev) => ({ ...prev, smtpPort: Number(e.target.value) || 0 }))}
                                    style={inputStyle}
                                    disabled={!runtime.smtpEnabled}
                                />
                            </div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-text-secondary)', paddingBottom: 12 }}>
                                <input
                                    type="checkbox"
                                    checked={runtime.smtpSecure}
                                    onChange={(e) => setRuntime((prev) => ({ ...prev, smtpSecure: e.target.checked }))}
                                    disabled={!runtime.smtpEnabled}
                                />
                                启用 TLS/SSL
                            </label>
                        </div>
                        {/* User */}
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>账号用户</div>
                            <input
                                value={runtime.smtpUser}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpUser: e.target.value }))}
                                placeholder="SMTP 用户名"
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                        {/* Pass */}
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>
                                账号密码
                                {runtime.smtpPassMasked && <span style={{ color: 'var(--color-primary)', marginLeft: 8, fontSize: 12 }}>(当前已设置)</span>}
                            </div>
                            <input
                                type="password"
                                value={smtpPass}
                                onChange={(e) => setSmtpPass(e.target.value)}
                                placeholder="输入以更改密码..."
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                        {/* From */}
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>发件人地址</div>
                            <input
                                value={runtime.smtpFrom}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpFrom: e.target.value }))}
                                placeholder="例如: admin@example.com"
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                        {/* To */}
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>接收地址</div>
                            <input
                                value={runtime.smtpTo}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpTo: e.target.value }))}
                                placeholder="例如: target@example.com"
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>

                    </div>
                </div>

            </div>
        </div>
    );
}
