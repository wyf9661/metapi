# 故障排查速查（面向用户 agent）

## 401 认证失败

- 检查 `AUTH_TOKEN` 是否正确读取（从环境变量 / 用户提供 / /etc/metapi/env）。
- 检查用的是管理接口还是代理接口：`/api/*` 用 AUTH_TOKEN，`/v1/*` 用 downstream key，混用会 401。

## 站点模型为空

1. 检查 URL 路径：上游 New API/Sub2API 的入口 URL 是否需要 `/v1`、`/api` 或 `/api/v1` 前缀。
2. 检查上游 key 的 group 是否匹配该模型的 `enable_groups`（New API 常见问题）。
3. 检查 platform 类型是否探测正确。
4. 检查账号凭据模式与 token 来源。
5. 重新同步模型（`POST /api/account-tokens/sync/:accountId` 或站点探测），不要直接清库。

## 测活成功但实际调用失败

- 确认代理请求使用的是 downstream key（不是 AUTH_TOKEN）。
- 检查模型名拼写是否精确（大小写、provider 前缀如 `deepseek-ai/`）。
- 确认路由实际选用的凭据（account token vs apiToken vs accessToken）。
- 查看代理日志：`GET /api/stats/proxy-logs`，按 `requestTraceId` 聚合同一请求的多次尝试，看最终结果。

## 403 / 405 / 429 / 5xx

- `403 Your request was blocked` 或 Cloudflare 相关错误：是上游 WAF/出口 IP 被风控，不是 key 问题。不要反复重试同一站点，多个站点同时出现说明出口 IP 受限。
- WAF 403 后换协议报 405：说明该上游不支持该协议，不要继续换。
- 429：上游限流，稍后重试或等冷却。
- 5xx：上游服务异常，检查上游站点状态。

## 单次 401 不要判定账号过期

单次 401 可能是网络抖动或上游临时问题。token 过期判定需要：明确的 invalid/expired 文案 + 多次观测 + 复查验证。不要因为一次失败就建议用户删除账号。

## 任务卡在 queued

```bash
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/tasks" | jq
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/tasks/$JOB_ID" | jq
```

检查任务状态与错误信息。长时间卡住检查上游站点是否可达。

## 站点显示余额为 0 或未知

- 余额刷新需要 session 凭据；apikey 账号通常无法刷新余额。
- 尝试 `POST /api/accounts/:id/balance`。

## 服务异常排查（若 agent 在部署机上）

```bash
sudo systemctl status metapi --no-pager
sudo journalctl -u metapi -n 120 --no-pager
curl -fsS http://127.0.0.1:5000/api/health/ready
```

注意：MetAPI 的 cloudflared 隧道由 metapi 服务子进程启动，独立 `cloudflared-tunnel.service` inactive 是正常的，不要误修。稳定隧道地址在 `/var/lib/metapi/tunnel/state.json` 的 `publicUrl` 字段。
