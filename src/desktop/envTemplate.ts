/**
 * Desktop user-config template.
 *
 * Written to <userData>/.env.example on first launch (userData on Windows is
 * %APPDATA%\Metapi). The backend loads <userData>/.env at startup (see
 * buildDesktopServerEnv in runtime.ts) — copy this file to `.env` and edit
 * values to override defaults. Comments are safe to keep in `.env`.
 */
export const DESKTOP_ENV_TEMPLATE = `# ─────────────────────────────────────────────────────────────
# Metapi 桌面版用户配置文件（.env）
#
# 将本文件复制为 .env 并修改其中的值即可覆盖默认配置。
#   Windows 路径：%APPDATA%\\Metapi\\.env
# 修改后重启应用生效。删除 .env 即恢复默认。
# ─────────────────────────────────────────────────────────────

# ── 测活 / 探活 ─────────────────────────────────────────────
# 模型可用性批量测活（默认关闭，需 MODEL_AVAILABILITY_PROBE_ALLOW 与
# MODEL_AVAILABILITY_PROBE_ENABLED 同时为 true 才生效；也可以在
# 后台「设置」中开关）。
MODEL_AVAILABILITY_PROBE_ENABLED=false
# 批量测活间隔（毫秒），默认 1800000（30 分钟），下限 60000。
# MODEL_AVAILABILITY_PROBE_INTERVAL_MS=1800000
# 批量测活单次超时（毫秒），默认 30000，下限 3000。
# MODEL_AVAILABILITY_PROBE_TIMEOUT_MS=30000
# 批量测活并发数，默认 1，上限 2。
# MODEL_AVAILABILITY_PROBE_CONCURRENCY=1

# 通道心跳测活（活跃通道保活 + 冷却恢复探测）。
# 心跳扫描间隔（毫秒），默认 120000（2 分钟），下限 60000。
# PROBE_HEARTBEAT_INTERVAL_MS=120000
# 心跳单次探测超时（毫秒），默认 30000，下限 3000。
# PROBE_HEARTBEAT_TIMEOUT_MS=30000
# 每轮心跳探测的最大批次数，默认 2，上限 4。
# PROBE_MAX_BATCH=2
# 冷却结束后自动重试探测的次数，默认 2，上限 5。
# PROBE_INITIAL_RETRIES_AFTER_COOLDOWN=2

# ── 代理 / 路由 ─────────────────────────────────────────────
# 单次尝试的首字超时（秒），默认 30。通道失败切换相关参数一般无需改动。
# PROXY_FIRST_BYTE_TIMEOUT_SEC=30
# 粘性会话 TTL（毫秒），默认 30000。调低可让流量更均衡地分散到各站点。
# PROXY_STICKY_SESSION_TTL_MS=30000

# ── 通知 ────────────────────────────────────────────────────
# 通知渠道建议在后台「通知设置」页面配置；如需脚本注入可在此覆盖。
# WEBHOOK_URL=
# BARK_URL=
# SERVERCHAN_KEY=
# TELEGRAM_ENABLED=false
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
# 同类告警的最小间隔（秒），默认 300。
# NOTIFY_COOLDOWN_SEC=300

# ── 其他 ────────────────────────────────────────────────────
# 时区，默认 Asia/Shanghai。
# TZ=Asia/Shanghai
# 管理后台登录令牌（默认由应用自动生成随机值；如在此显式设置，
# 请使用足够强的随机串，>=8 字符）。
# AUTH_TOKEN=
`;
