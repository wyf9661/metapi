# ⚙️ 配置说明

本文档按实际使用场景说明 Metapi 的配置入口。

对大多数用户来说，日常配置优先通过管理后台完成；环境变量主要用于首次启动、部署级参数和当前没有 UI 的高级项。

[返回文档中心](./README.md)

---

## 概述

Metapi 当前有三类主要配置入口：

1. **管理后台「设置」** — 适合日常系统设置与运行时调整
2. **管理后台「通知设置」与「下游密钥」** — 适合通知渠道和项目级下游 Key 管理
3. **环境变量** — 适合首次启动、部署级参数、OAuth client 覆盖、Deploy Helper token 等当前没有 UI 的项

下表可用于快速判断：

| 你要改什么 | 优先去哪里 | 说明 |
|----------|------------|------|
| 日常系统设置 | 管理后台「设置」 | 大部分运行时配置都在这里，保存后直接生效或按提示重启 |
| 通知渠道 | 管理后台「通知设置」 | Webhook / Bark / Server酱 / Telegram / SMTP 都有 UI |
| 下游项目级 Key | 管理后台「下游密钥」 | 不要再回到环境变量里硬塞 |
| 首次启动令牌、端口、数据目录 | `.env` / 容器环境变量 | 这类属于部署级初始化 |
| OAuth 客户端 ID / Secret | `.env` / 容器环境变量 | 当前没有 UI |
| Deploy Helper token / helper 进程参数 | `.env` / helper manifest | 当前没有 UI，且属于集群侧部署参数 |
| 少数高级部署级参数 | `.env` / 容器环境变量 | 例如日志保留、部分探测细粒度参数 |

---

## 配置入口总览

### 1. 管理后台「设置」

侧边栏入口：**系统 → 设置**

当前已经能直接在这里配置的内容包括：

| UI 项 | 对应能力 | 生效方式 |
|------|----------|----------|
| 管理员登录令牌 | `AUTH_TOKEN` 的后续修改 | 保存后即时生效 |
| 定时任务 | `CHECKIN_CRON`、`BALANCE_REFRESH_CRON`、日志清理计划 | 保存后即时生效 |
| 系统代理 | `SYSTEM_PROXY_URL` | 保存后即时生效 |
| 代理失败判定 | 失败关键词、空内容失败判定 | 保存后即时生效 |
| Codex 上游传输与会话并发 | WebSocket 开关、并发与队列参数 | 保存后即时生效 |
| 批量测活 | 后台模型可用性探测开关 | 保存后即时生效 |
| 下游访问令牌 | `PROXY_TOKEN` | 保存后即时生效 |
| 路由策略 | 成本/余额/使用率权重、默认单价、首字超时、协议回退、失败冷却上限 | 保存后即时生效 |
| 全局品牌屏蔽 | 全局品牌屏蔽 | 保存后即时生效，并触发路由重建 |
| 全局模型白名单 | 全局模型白名单 | 保存后即时生效，并触发路由重建 |
| 数据库迁移 / 运行数据库 | `DB_TYPE`、`DB_URL`、`DB_SSL` | 保存后下次后端重启生效 |
| 更新中心 | K3s / Helm 更新中心配置 | 保存后即时生效 |
| 会话与安全 | `ADMIN_IP_ALLOWLIST` | 保存后即时生效 |

> [!TIP]
> `AUTH_TOKEN` 和 `PROXY_TOKEN` 并不是“只能靠环境变量改”的配置。
> 正常情况下，**首次启动先给一个值，后续都可以在 UI 里改**。

### 2. 管理后台「通知设置」

侧边栏入口：**系统 → 通知设置**

当前已经有独立页面可直接配置：

| UI 项 | 说明 | 生效方式 |
|------|------|----------|
| Webhook | 企业微信 / 飞书 / 通用 Webhook | 保存后即时生效 |
| Bark | Bark 推送地址与开关 | 保存后即时生效 |
| Server酱 | SendKey 与开关 | 保存后即时生效 |
| Telegram | API Base URL、Chat ID、Topic ID、Bot Token、是否走系统代理 | 保存后即时生效 |
| SMTP | SMTP 主机、端口、账号、密码、发件/收件地址 | 保存后即时生效 |
| 告警冷静期 | `NOTIFY_COOLDOWN_SEC` | 保存后即时生效 |

通知设置页面已经支持：

- 直接保存
- 直接发测试通知
- 屏蔽回显已保存的敏感字段

通知配置可直接在该页面完成，无需先记环境变量名。

### 3. 管理后台「下游密钥」

侧边栏入口：**控制台 → 下游密钥**

「下游密钥」页面负责的是项目级下游 API Key，而不是全局 `PROXY_TOKEN`。

适合在这里配置的内容：

- Key 名称
- 过期时间
- 费用 / 请求上限
- 模型白名单
- 路由白名单
- 站点权重倍率
- 启停、重置用量、趋势与统计

这类能力可直接在页面里完成，不需要额外依赖环境变量。

---

## 首次启动时，至少准备这些环境变量

**首次把服务跑起来**时，建议先在环境变量里准备以下几项：

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `AUTH_TOKEN` | 初始管理员登录令牌 | `change-me-admin-token` |
| `PROXY_TOKEN` | 初始下游访问令牌 | `change-me-proxy-sk-token` |
| `PORT` | 服务监听端口 | `4000` |
| `DATA_DIR` | 数据目录（SQLite 默认落这里） | `./data` |
| `TZ` | 时区 | `Asia/Shanghai` |

说明：

- `AUTH_TOKEN` 只是**第一次登录前**必须要有；登录后可以去「设置」里改。
- `PROXY_TOKEN` 也只是建议先给一个初始值；后续可以在「设置」里改。
- `PORT`、`DATA_DIR`、`TZ` 这类属于部署级参数，更适合留在环境变量。

---

## 环境变量配置

### 1. 启动与部署级

这类配置要么属于进程启动参数，要么属于当前确实没有 UI 的部署项：

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | 服务监听端口 | `4000` |
| `DATA_DIR` | 数据目录（SQLite 数据库存储位置） | `./data` |
| `TZ` | 时区 | `Asia/Shanghai` |
| `ACCOUNT_CREDENTIAL_SECRET` | 账号凭证加密密钥（用于加密存储的上游账号密码） | 默认使用 `AUTH_TOKEN` |

### 2. OAuth 与 Provider 登录

这一节只在你需要覆盖默认 OAuth client 配置时才看。

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `CODEX_CLIENT_ID` | 覆盖内置 Codex OAuth Client ID | 内置默认值 |
| `CLAUDE_CLIENT_ID` | 覆盖内置 Claude OAuth Client ID | 内置默认值 |
| `CLAUDE_CLIENT_SECRET` | 预留的 Claude OAuth Client Secret（默认留空） | 空 |
| `GEMINI_CLI_CLIENT_ID` | 覆盖内置 Gemini CLI OAuth Client ID | 内置默认值 |
| `GEMINI_CLI_CLIENT_SECRET` | 覆盖内置 Gemini CLI OAuth Client Secret | 内置默认值 |

说明：

- `Antigravity` 当前不需要额外环境变量即可启用。
- 如果你的部署环境访问 provider 受限，优先先在 UI 里配置**系统代理**。
- 如果 OAuth 页面运行在远程服务器上，还要考虑 SSH 隧道或手动回填 callback，详见 [OAuth 管理](./oauth.md)。

### 3. K3s 更新中心与 Deploy Helper

这里要分清楚两层：

- **主 Metapi 后台里的日常更新中心配置**：优先在 UI 里填
- **主服务访问 helper 的 token / helper 自己的监听参数**：仍然是环境变量

#### 主 Metapi 服务

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DEPLOY_HELPER_TOKEN` | 主服务访问 Deploy Helper 的 Bearer Token | 空 |
| `UPDATE_CENTER_HELPER_TOKEN` | `DEPLOY_HELPER_TOKEN` 的兼容别名，二选一即可 | 空 |

#### Deploy Helper 服务

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DEPLOY_HELPER_HOST` | helper 监听地址 | `0.0.0.0` |
| `DEPLOY_HELPER_PORT` | helper 监听端口 | `9850` |
| `DEPLOY_HELPER_TOKEN` | helper Bearer Token，必须和主服务一致 | 空 |

#### 更新中心里真正建议在 UI 配的字段

这些字段不建议再教用户去改 env，而是直接去：

**设置 → 更新中心**

- `helperBaseUrl`
- `namespace`
- `releaseName`
- `chartRef`
- `imageRepository`
- `githubReleasesEnabled`
- `dockerHubTagsEnabled`
- `defaultDeploySource`

完整接入步骤见 [K3s 更新中心（高级）](./k3s-update-center.md)。

### 4. 当前没有 UI 的高级部署级参数

下面这些参数目前更偏部署级，仍然建议通过环境变量维护：

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `TOKEN_ROUTER_CACHE_TTL_MS` | Token 路由缓存 TTL（毫秒） | `1500` |
| `PROXY_LOG_RETENTION_DAYS` | 代理日志保留天数 | `30` |
| `PROXY_LOG_RETENTION_PRUNE_INTERVAL_MINUTES` | 代理日志清理任务执行间隔（分钟） | `30` |
| `MODEL_AVAILABILITY_PROBE_ALLOW` | 是否允许启用批量测活（默认禁止） | `false` |
| `MODEL_AVAILABILITY_PROBE_ENABLED` | 批量测活开关（需先设 `MODEL_AVAILABILITY_PROBE_ALLOW=true` 才生效） | `false` |
| `MODEL_AVAILABILITY_PROBE_INTERVAL_MS` | 批量测活间隔（毫秒） | `1800000` |
| `MODEL_AVAILABILITY_PROBE_TIMEOUT_MS` | 批量测活单次探测超时（毫秒） | `30000` |
| `PROXY_FIRST_BYTE_TIMEOUT_SEC` | 单次通道首字超时（秒）；0 关闭 | `30` |
| `PROXY_STICKY_SESSION_TTL_MS` | soft sticky / 会话粘性 TTL（毫秒） | `30000` |
| `PROXY_CHANNEL_FAILOVER_BUDGET_MS` | 多通道 failover 总预算（毫秒）；0 用 soft 默认 30s | `0` |
| `MODEL_AVAILABILITY_PROBE_CONCURRENCY` | 批量测活并发数 | `1` |

注意：

- **批量测活开关本身**已经在 UI 里有了
- 这里只剩下间隔、超时、并发这些更高级的细项还没有 UI

### 5. 路由与故障转移（proxy 核心行为）

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PROXY_FAILOVER_BACKOFF_MS` | 瞬时恢复型失败（WAF 403 / 裸 403 / 429 / 5xx）在切换通道前等待的毫秒数。这些失败通常几秒内恢复，短暂等待能显著提高重试成功率；设为 `0` 关闭（立即切换，旧行为） | `1200` |
| `PROXY_CHANNEL_FAILOVER_MAX_ATTEMPTS` | 单次请求最多尝试的通道数上限（min(候选池, 上限)，防止候选过多时客户端被反复切换拖死） | `8` |
| `PROXY_MAX_CHANNEL_ATTEMPTS` | 候选通道数统计失败时的兜底尝试次数 | `5` |
| `PROXY_STICKY_SESSION_ENABLED` | 是否启用会话粘性（同一会话尽量复用同一通道） | `true` |
| `PROXY_STICKY_MAX_HITS` | 会话级粘性连续命中次数上限，超过后丢弃会话级粘性、重新进入均衡选择（防止单会话独占单站）。**只作用于会话粘性，不影响 last_success 保底** | `5` |
| `PROXY_LAST_SUCCESS_EXPLORATION_INTERVAL` | last_success（最近成功通道保底）连续使用次数上限，达到后让出 1 次给 balanced-v2 探索其他健康候选。探索成功会自动更新保底指向新站点；探索失败保留原保底。设为 `1` 表示每次都探索（等效关闭保底优先），调大表示更黏好站点 | `10` |
| `PROXY_SESSION_CHANNEL_CONCURRENCY_LIMIT` | 会话级通道并发上限（0 = 不限制） | `3` |
| `PROXY_SESSION_CHANNEL_QUEUE_WAIT_MS` | 并发超限时的排队等待时间（毫秒） | `1500` |
| `PROXY_SESSION_CHANNEL_LEASE_TTL_MS` | 会话级通道租约 TTL（毫秒） | `90000` |
| `PROXY_SESSION_CHANNEL_LEASE_KEEPALIVE_MS` | 会话级通道租约保活间隔（毫秒） | `15000` |
| `TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC` | 通道失败冷却上限（秒），冷却期内该通道优先避开 | `3600` |
| `DISABLE_CROSS_PROTOCOL_FALLBACK` | 关闭跨协议回退（如 chat → responses），默认允许 | `false` |
| `RESPONSES_COMPACT_FALLBACK_TO_RESPONSES_ENABLED` | Responses 压缩模式回退开关 | `false` |
| `CODEX_UPSTREAM_WEBSOCKET_ENABLED` | 启用 Codex 上游 WebSocket 传输 | `false` |
| `CODEX_RESPONSES_WEBSOCKET_BETA` | Codex responses WebSocket beta 版本头 | `responses_websockets=2026-02-06` |
| `CODEX_HEADER_DEFAULTS_USER_AGENT` | 覆盖 Codex 默认 User-Agent 头 | 空 |
| `CODEX_HEADER_DEFAULTS_BETA_FEATURES` | 覆盖 Codex 默认 beta-features 头 | 空 |
| `PROXY_EMPTY_CONTENT_FAIL` | 上游返回空内容时按失败处理 | `false` |
| `PROXY_ERROR_KEYWORDS` | 逗号分隔的关键词列表，命中即判定为代理错误（用于日志/告警分类） | 空 |
| `ROUTING_FALLBACK_UNIT_COST` | 路由成本兜底值（成本未知时的默认单价） | `1` |

### 6. 代理调试（trace 抓包）

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PROXY_DEBUG_TRACE_ENABLED` | 开启代理调试 trace 记录 | `false` |
| `PROXY_DEBUG_CAPTURE_HEADERS` | 记录请求/响应头 | `true` |
| `PROXY_DEBUG_CAPTURE_BODIES` | 记录请求/响应体（体积大，默认关） | `false` |
| `PROXY_DEBUG_CAPTURE_STREAM_CHUNKS` | 记录流式响应分片 | `false` |
| `PROXY_DEBUG_TARGET_SESSION_ID` | 只抓指定会话的调试数据 | 空 |
| `PROXY_DEBUG_TARGET_CLIENT_KIND` | 只抓指定客户端类型（如 `cursor`/`codex`） | 空 |
| `PROXY_DEBUG_TARGET_MODEL` | 只抓指定模型的调试数据 | 空 |
| `PROXY_DEBUG_RETENTION_HOURS` | 调试数据保留小时数 | `24` |
| `PROXY_DEBUG_MAX_BODY_BYTES` | 单条调试记录 body 大小上限（字节） | `262144` |

### 7. 文件与日志清理

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PROXY_FILE_RETENTION_DAYS` | 代理文件（上传/下载缓存）保留天数 | `30` |
| `PROXY_FILE_RETENTION_PRUNE_INTERVAL_MINUTES` | 文件清理任务执行间隔（分钟） | `60` |
| `LOG_CLEANUP_CRON` | 日志清理 cron 表达式 | `0 6 * * *` |
| `LOG_CLEANUP_USAGE_LOGS_ENABLED` | 是否清理用量日志 | `false` |
| `LOG_CLEANUP_PROGRAM_LOGS_ENABLED` | 是否清理程序日志 | `false` |
| `LOG_CLEANUP_RETENTION_DAYS` | 日志保留天数 | `30` |

### 8. 路由权重（智能路由打分）

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `BASE_WEIGHT_FACTOR` | 基础权重因子 | `0.5` |
| `VALUE_SCORE_FACTOR` | 价值分权重因子 | `0.5` |
| `COST_WEIGHT` | 成本权重 | `0.4` |
| `BALANCE_WEIGHT` | 余额权重 | `0.3` |
| `USAGE_WEIGHT` | 用量权重 | `0.3` |

### 9. 规则与高级 JSON 配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PAYLOAD_RULES` / `PAYLOAD_RULES_JSON` | 请求体规则（JSON），二选一 | 空 |
| `OPENAI_SERVICE_TIER_RULES` / `OPENAI_SERVICE_TIER_RULES_JSON` | OpenAI service tier 规则（JSON），二选一 | 空 |
| `PROBE_HEARTBEAT_INTERVAL_MS` | 活跃通道心跳探测间隔（毫秒） | `120000` |
| `PROBE_HEARTBEAT_TIMEOUT_MS` | 心跳探测超时（毫秒） | `30000` |
| `PROBE_MAX_BATCH` | 心跳探测每批通道数 | `2` |
| `PROBE_INITIAL_RETRIES_AFTER_COOLDOWN` | 冷却后初始重试次数 | `2` |

### 10. 安全与访问控制

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `ALLOW_GLOBAL_PROXY_TOKEN` | 允许客户端直接使用全局 `PROXY_TOKEN` 调用 `/v1/*`（生产环境建议 `false`，改用 UI 生成的下游密钥） | 非生产环境 `true` / 生产环境 `false` |
| `ALLOW_INSECURE_DEFAULTS` | 跳过生产安全检查（仅紧急排障用，不推荐） | `false` |
| `ADMIN_IP_ALLOWLIST` | 管理员接口 IP 白名单（逗号分隔 CIDR） | 空 |
| `TRUST_PROXY` | 信任反向代理的 `X-Forwarded-For` | `false` |
| `TRUST_PROXY_HOPS` | 仅信任最近 N 跳（设置了 `TRUST_PROXY` 后生效） | 未设置（沿用旧行为） |
| `NOTIFY_COOLDOWN_SEC` | 同一告警重复推送的最小间隔（秒） | `300` |
| `TUNNEL_ENABLED` | 启用 Cloudflare Quick Tunnel | `false` |
| `TUNNEL_DASHBOARD_ACCESS` | 允许通过隧道访问管理后台 | `false` |

### 11. 数据库连接

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DB_TYPE` | 数据库类型：`sqlite` / `mysql` / `postgres` | `sqlite` |
| `DB_URL` | 数据库连接串（MySQL/Postgres 必填） | 空 |
| `DB_SSL` | 启用数据库 SSL | `false` |
| `DB_SSL_REJECT_UNAUTHORIZED` | SSL 证书校验（自签名证书时设 `false`） | `true` |

### 12. 登录签到（Check-in）

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `CHECKIN_CRON` | 定时签到 cron 表达式 | `0 8 * * *` |
| `CHECKIN_SCHEDULE_MODE` | 调度方式：`cron` / `interval` | `cron` |
| `CHECKIN_INTERVAL_HOURS` | interval 模式下的间隔小时数（1-24） | `6` |
| `BALANCE_REFRESH_CRON` | 余额刷新 cron 表达式 | `0 * * * *` |
| `HOST` | 服务监听地址 | `0.0.0.0` |
| `NODE_ENV` | 运行环境（`production` 会启用生产安全检查） | 空 |

---

## 常见配置与入口对照

### 通常已经有 UI 的配置

- 管理员令牌
- 下游访问令牌
- 系统代理
- 定时任务
- 路由策略
- 批量测活开关
- 安全白名单
- 通知渠道
- 下游密钥
- 数据库运行配置
- 更新中心主体配置

### 通常仍需看环境变量的配置

- 端口
- 数据目录
- 时区
- 账号凭证加密密钥
- OAuth client 覆盖
- Deploy Helper token
- helper 进程自身监听参数
- 少数高级部署级性能 / 清理参数

---

## UI 与环境变量的关系

Metapi 当前的配置关系可以概括为：

1. **环境变量负责启动默认值和部署参数**
2. **UI 负责用户日常操作和运行时调整**
3. **UI 保存后的值会持久化到当前运行数据库**
4. **大多数 UI 设置会覆盖原始默认值**

例外主要有两类：

- **纯部署级参数**：例如端口、数据目录
- **保存后需重启的配置**：例如运行数据库类型 / 连接串 / SSL

---

## 通知渠道详细说明

虽然我更推荐直接去「通知设置」页面，但为了方便查字段，这里保留一个速查表。

### Webhook

| UI / 变量 | 说明 | 默认值 |
|--------|------|--------|
| `WEBHOOK_ENABLED` | 启用 Webhook 通知 | `true` |
| `WEBHOOK_URL` | Webhook 推送地址 | 空 |
| `WEBHOOK_SECRET` | Webhook 签名密钥（可选） | 空 |

### Bark（iOS 推送）

| UI / 变量 | 说明 | 默认值 |
|--------|------|--------|
| `BARK_ENABLED` | 启用 Bark 推送 | `true` |
| `BARK_URL` | Bark 推送地址 | 空 |

### Server酱

| UI / 变量 | 说明 | 默认值 |
|--------|------|--------|
| `SERVERCHAN_ENABLED` | 启用 Server酱 通知 | `true` |
| `SERVERCHAN_KEY` | Server酱 SendKey | 空 |

### Telegram Bot

| UI / 变量 | 说明 | 默认值 |
|--------|------|--------|
| `TELEGRAM_ENABLED` | 启用 Telegram 通知 | `false` |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token（形如 `123456:abc`） | 空 |
| `TELEGRAM_CHAT_ID` | 接收消息的 Chat ID（如 `-100xxxx` 或 `@channel`） | 空 |
| `TELEGRAM_MESSAGE_THREAD_ID` | 话题群组中的 Thread ID（非话题群可留空） | 空 |

**配置步骤：**

1. **创建 Bot**：在 Telegram 中搜索 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，按提示设置名称后获取 Bot Token
2. **获取 Chat ID**：
   - 个人聊天：给 Bot 发消息后，通过 `getUpdates` 或 @userinfobot / @getmyid_bot 查看 `chat.id`
   - 群组：把 Bot 拉进群并发送消息后，通过 `getUpdates` 查看群组 Chat ID
   - 频道：可直接使用 `@your_channel`（前提是 Bot 是频道管理员）
3. **填入位置**：优先去 **通知设置** 页面填写
4. **大陆服务器反代**：如果服务器不能直连 Telegram，可在 UI 里填写 `Telegram API Base URL`
5. **测试**：保存后直接点“发送测试通知”

### SMTP 邮件

| UI / 变量 | 说明 | 默认值 |
|--------|------|--------|
| `SMTP_ENABLED` | 启用邮件通知 | `false` |
| `SMTP_HOST` | SMTP 服务器地址 | 空 |
| `SMTP_PORT` | SMTP 端口 | `587` |
| `SMTP_SECURE` | 使用 SSL/TLS | `false` |
| `SMTP_USER` | SMTP 用户名 | 空 |
| `SMTP_PASS` | SMTP 密码 | 空 |
| `SMTP_FROM` | 发件人地址 | 空 |
| `SMTP_TO` | 收件人地址 | 空 |

### 告警控制

| UI / 变量 | 说明 | 默认值 |
|--------|------|--------|
| `NOTIFY_COOLDOWN_SEC` | 相同告警冷静期（秒），防止同一事件重复通知 | `300` |

---

## 站点公告

管理后台新增了「站点公告」页面，用于保存和浏览 Metapi 已同步到本地的上游公告记录。

- 首次发现的上游公告会写入站内通知，并按现有通知渠道外发一次
- 后续重复同步只更新本地公告记录，不会重复外发同一条公告
- 当前支持的上游公告来源包括 `new-api` 与 `sub2api`
- 「清空公告」只删除 Metapi 本地保存的公告记录，不会修改上游站点数据

## 更新提醒

更新中心现在会在后台定时检查 GitHub Releases / Docker Hub 的可部署候选，并把结果保存为本地运行时状态。

- 首次发现新的版本候选或新的 Docker digest 时，会写入站内通知，并按现有通知渠道外发一次
- 相同候选后续重复检查只更新本地运行时状态，不会重复外发同一条提醒
- 这类提醒不会自动触发部署，只是把用户带到「设置 → 更新中心」继续手动确认和执行
- K3s 用户可以在收到提醒后直接去更新中心部署；Compose 用户也可以收到提醒，但仍按自己的升级方式处理

## 下一步

- [部署指南](./deployment.md) — Docker Compose 与反向代理
- [K3s 更新中心（高级）](./k3s-update-center.md) — K3s / Helm 用户的后台升级入口
- [客户端接入](./client-integration.md) — 对接下游应用
- [上游接入](./upstream-integration.md) — 添加和管理上游平台
- [OAuth 管理](./oauth.md) — 授权 Codex / Claude / Gemini CLI / Antigravity
- [运维手册](./operations.md) — 备份、日志与健康检查
