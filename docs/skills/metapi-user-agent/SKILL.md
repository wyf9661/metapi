---
name: metapi-user-agent
description: "Use when operating a MetAPI gateway via its API."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [metapi, gateway, sites, accounts, tokens, api]
    related_skills: [metapi-usage]
---

# MetAPI 网关操作（面向用户 agent）

本 skill 供**用户的 AI agent** 使用：用户已部署 MetAPI（聚合 AI 中转站的统一网关），agent 通过管理 API 帮助用户完成日常运维——添加站点、添加账号、同步 token、模型测活、签到、查统计、排查故障。

适用对象：任何能发 HTTP 请求的 agent。所有操作通过 REST API 完成，不依赖本机部署路径；凭据由用户提供。

## 连接信息（第一步必做）

agent 启动时按以下顺序确定连接参数：

1. 环境变量：`METAPI_BASE_URL`、`METAPI_AUTH_TOKEN`
2. 用户在对话中提供
3. 本机部署兜底：`/etc/metapi/env` 中 `AUTH_TOKEN`（仅当 agent 运行在部署机上且有读取权限）

```bash
BASE="${METAPI_BASE_URL:-http://127.0.0.1:5000}"
AUTH_TOKEN="${METAPI_AUTH_TOKEN:-}"
# 若为空且本机可读，则从环境文件读取，且绝不打印完整值
```

先做健康检查再操作：

```bash
curl -fsS "$BASE/api/health/live"
curl -fsS "$BASE/api/health/ready"   # 含真实数据库检查，更有意义
```

管理请求模板：

```bash
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/..." | jq
```

401 = 认证失败（token 错误/缺失），不是数据库故障。

## 核心概念（操作前必须理解）

MetAPI 有四个不能混淆的层级：

```text
site（上游站点，如某个 New API / Sub2API 站）
  └─ account（上游账号凭据，session 登录态 或 API key）
       └─ account_tokens（session 账号管理的下游 API token）
            └─ 模型覆盖 / token routes（路由）
```

- **downstream key** 是 MetAPI 发给调用方的代理 key（走 `/v1/*`）；**AUTH_TOKEN** 是管理凭据（走 `/api/*`）。两者不同，不能混用。
- 模型状态：`available` = 被发现/列出；`connectivity` = 被探测或真实流量验证。不要混淆。
- 创建/同步类操作常返回 `queued`/`jobId`，必须轮询 `GET /api/tasks/:id` 到终态再报告结果。

## 常用操作速查

| 用户需求 | 操作 | 详见 |
|---|---|---|
| 添加站点 | POST /api/sites + POST /api/sites/detect | references/operations.md |
| 添加账号（API key） | POST /api/accounts（credentialMode=apikey） | references/operations.md |
| 添加账号（session） | POST /api/accounts（credentialMode=session） | references/operations.md |
| 查看余额/站点统计 | GET /api/sites、GET /api/accounts | references/operations.md |
| 同步 token | POST /api/account-tokens/sync/:accountId | references/operations.md |
| 禁用/删除站点或账号 | PUT/DELETE /api/sites/:id、/api/accounts/:id | references/operations.md |
| 模型测活 | POST /api/models/probe-one | references/operations.md |
| 签到 | POST /api/checkin/trigger | references/operations.md |
| 查代理日志/统计 | GET /api/stats/*、GET /api/proxy-logs | references/operations.md |
| 故障排查 | 错误速查表 | references/troubleshooting.md |

## 安全规则（不可违反）

1. token、密码、凭据不得写入文件、日志、聊天回复或命令历史。
2. 列表接口返回的 token 都是掩码的；完整值只通过 `GET /api/account-tokens/:id/value` 读取，且仅在用户明确需要时。
3. 删除站点/账号、清理数据等破坏性操作：先向用户确认，展示将影响的 ID 和级联范围。
4. 敏感配置（如 webhookSecret）从响应中删除后再展示。

## 完成标准

- [ ] 连接参数已确认，health/ready 通过
- [ ] 所有 ID 来自 API 返回，不是名称猜测
- [ ] 管理接口用 AUTH_TOKEN，代理接口用 downstream key
- [ ] 创建类操作已轮询任务到终态
- [ ] 敏感值全程未泄露
- [ ] 破坏性操作已获用户明确确认
