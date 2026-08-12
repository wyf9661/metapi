# 详细操作手册（面向用户 agent）

所有命令使用前先确认连接变量：

```bash
BASE="${METAPI_BASE_URL:-http://127.0.0.1:5000}"
AUTH_TOKEN="${METAPI_AUTH_TOKEN:-}"
```

## 1. 查看现状（先读后改）

```bash
# 所有站点（含余额、今日消费、连接统计）
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/sites" | jq

# 单站点详情
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/sites/1" | jq

# 账号快照（含凭据模式、状态）
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/accounts" | jq

# 某站点的可用模型
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/sites/1/available-models" | jq

# 代理调用日志 / 统计
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/stats/proxy-logs" | jq
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/stats/dashboard" | jq
```

## 2. 添加站点（上游网关）

### 流程：查重 → 检测平台 → 创建 → 验证

```bash
# 1) 检查是否已存在相同平台+URL 的站点（避免重复）
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/sites" | jq '.[] | {id,name,url,platform,status}'

# 2) （可选）让 MetAPI 检测平台类型
curl -fsS -X POST "$BASE/api/sites/detect" \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://你的中转站地址"}' | jq
# 返回 { url, platform }；platform 通常是 new-api / one-api / sub2api / openai 等

# 3) 创建站点
curl -fsS -X POST "$BASE/api/sites" \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"站点显示名","url":"https://你的中转站地址","platform":"new-api","status":"active"}' | jq
```

要点：

- `name`、`url` 必填；`platform` 省略会自动探测，但生产建议显式指定。
- 同一 `平台+URL` 不能重复绑定（重复会 409）。
- 站点创建后**还没有可用凭据**，必须继续添加账号（第 3 节）才能路由模型。
- 可选字段：`proxyUrl`（代理）、`customHeaders`、`paramOverride`、`globalWeight`（路由权重）、`isPinned`、`sortOrder`。
- 多入口：`apiEndpoints: [{"url":"...","enabled":true,"sortOrder":0}, ...]`，URL 必须 http(s) 且不重复；更新时该字段是**全量替换**（省略=不变，null/[]=清空）。

### 验证站点

```bash
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/sites" | jq '.[] | select(.name=="站点显示名") | {id,url,platform,status}'
```

## 3. 添加账号（上游凭据）

### 3a. API key 账号（推荐，最简单）

```bash
# 先验证 key 是否有效（不创建）
curl -fsS -X POST "$BASE/api/accounts/verify-token" \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"siteId\":1,\"accessToken\":\"$UPSTREAM_KEY\",\"credentialMode\":\"apikey\"}" | jq
# 期望 success:true + modelCount

# 创建账号（key 从用户提供或安全输入读取，不要写进文件/历史）
curl -fsS -X POST "$BASE/api/accounts" \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"siteId\":1,\"accessToken\":\"$UPSTREAM_KEY\",\"credentialMode\":\"apikey\",\"checkinEnabled\":false}" | jq
```

### 3b. session 账号（用户名密码登录，支持签到）

```bash
curl -fsS -X POST "$BASE/api/accounts/login" \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"siteId\":1,\"username\":\"$UPSTREAM_USER\",\"password\":\"$UPSTREAM_PASS\"}" | jq
# 或手工创建：credentialMode:"session", checkinEnabled:true
```

### 3c. 等待后台任务

账号创建可能返回 `queued` + `jobId`，必须轮询到终态：

```bash
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/tasks/$JOB_ID" | jq
# 看到成功终态后再继续；不要把"已入队"当"已完成"
```

### 3d. 验证账号与模型

```bash
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/accounts" | jq '.accounts[] | {id,siteId,status,username}'
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/accounts/1/models" | jq
```

凭据模式速查：session=支持签到/余额/token 管理；apikey=仅转发，不支持签到；OAuth=由 OAuth 流程管理。

## 4. 管理 token（session 账号）

session 账号在上游平台有多个 API token 时可同步管理：

```bash
# 列出某账号的 token（值均掩码）
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/account-tokens?accountId=1" | jq

# 同步单个账号（拉取上游最新 token 列表）
curl -fsS -X POST "$BASE/api/account-tokens/sync/1" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq

# 同步所有账号
curl -fsS -X POST "$BASE/api/account-tokens/sync-all" \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"wait":false}' | jq
```

注意：`masked_pending` 状态的 token 不可用、不可设默认；只有 ready 且 enabled 的 token 才能设为默认。

## 5. 模型管理

```bash
# 查看/设置站点禁用模型（全量替换）
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/sites/1/disabled-models" | jq
curl -fsS -X PUT "$BASE/api/sites/1/disabled-models" \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"models":["某模型名"]}' | jq

# 单模型测活（推荐，不要全量扫）
curl -fsS -X POST "$BASE/api/models/probe-one" \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","siteId":1}' | jq
```

## 6. 签到

```bash
# 触发所有账号签到（通常返回后台任务）
curl -fsS -X POST "$BASE/api/checkin/trigger" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq

# 查看签到记录
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/checkin/logs" | jq
```

## 7. 禁用/删除

```bash
# 禁用站点（优先于删除）
curl -fsS -X PUT "$BASE/api/sites/1" \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"disabled"}' | jq

# 删除站点（级联删除账号/token/路由！必须先与用户确认）
curl -fsS -X DELETE "$BASE/api/sites/1" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq

# 删除账号
curl -fsS -X DELETE "$BASE/api/accounts/1" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq
```

## 8. 常用运维

```bash
# 强制刷新账号健康
curl -fsS -X POST "$BASE/api/accounts/health/refresh" \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"accountId":1,"wait":true}' | jq

# 刷新余额
curl -fsS -X POST "$BASE/api/accounts/1/balance" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq

# 运行时设置（敏感字段会自动掩码，但仍建议过滤展示）
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$BASE/api/settings/runtime" | jq
```

完整管理 API 列表见 `references/api-reference.md`。
