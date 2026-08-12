# API 路由索引（管理接口）

从源码提取。管理接口统一 `Authorization: Bearer $AUTH_TOKEN`；代理接口 `/v1/*` 用 downstream key。以实际部署版本的响应为准。

## 站点

- `GET /api/sites` — 全部站点及聚合统计
- `GET /api/sites/:id` — 单站点详情
- `POST /api/sites` — 创建站点
- `PUT /api/sites/:id` — 更新站点
- `DELETE /api/sites/:id` — 删除站点（级联）
- `POST /api/sites/batch` — 批量操作（enable/disable/delete）
- `POST /api/sites/detect` — 检测 URL 的平台类型
- `GET|PUT /api/sites/:id/disabled-models` — 站点禁用模型
- `GET /api/sites/:id/available-models` — 站点可用模型
- `POST /api/sites/:id/probe-now` — 触发站点探测
- `GET /api/sites/:id/probe-stream` — 探测进度（SSE）

## 账号

- `GET /api/accounts` — 账号快照（?refresh=true 强制刷新）
- `POST /api/accounts` — 创建账号（apikey/session）
- `POST /api/accounts/login` — 用户名密码登录并建号
- `POST /api/accounts/verify-token` — 验证凭据不建号
- `PUT /api/accounts/:id` — 更新账号
- `DELETE /api/accounts/:id` — 删除账号
- `POST /api/accounts/batch` — 批量 enable/disable/delete/refreshBalance
- `POST /api/accounts/health/refresh` — 刷新运行健康
- `POST /api/accounts/:id/balance` — 刷新余额
- `GET /api/accounts/:id/models` — 账号缓存模型
- `POST /api/accounts/:id/models/manual` — 手工模型覆盖
- `POST /api/accounts/:id/rebind-session` — 重新绑定 session

## Account token

- `GET|POST /api/account-tokens` — 列出/创建（session 账号）
- `PUT|DELETE /api/account-tokens/:id` — 更新/删除
- `POST /api/account-tokens/batch` — 批量操作
- `POST /api/account-tokens/:id/default` — 设为默认
- `GET /api/account-tokens/:id/value` — 读取完整值（掩码值 409）
- `POST /api/account-tokens/sync/:accountId` — 同步单账号
- `POST /api/account-tokens/sync-all` — 同步全部
- `GET /api/account-tokens/groups/:accountId` — token 分组
- `GET /api/account-tokens/account/:accountId/default` — 默认 token

## Downstream key（代理 key）

- `GET /api/downstream-keys` — 列表
- `POST /api/downstream-keys` — 创建
- `PUT|DELETE /api/downstream-keys/:id` — 更新/删除
- `GET /api/downstream-keys/summary` — 汇总
- `GET /api/downstream-keys/:id/overview|trend` — 详情/趋势
- `POST /api/downstream-keys/:id/reset-usage` — 重置用量
- `POST /api/downstream-keys/batch` — 批量操作

## 模型、探测、统计

- `GET /api/models/marketplace` — 模型市场
- `GET /api/models/token-candidates` — 路由候选
- `POST /api/models/check/:accountId` — 账号模型检查
- `POST /api/models/probe` — 全量测活（默认禁用）
- `POST /api/models/probe-one` — 单模型测活（推荐）
- `POST /api/models/probe-one/stream` — 单模型测活（SSE）
- `GET /api/probe-logs` — 探测日志
- `GET /api/stats/dashboard` — 看板统计
- `GET /api/stats/proxy-logs` — 代理日志
- `GET /api/stats/proxy-logs/:id` — 单条日志
- `GET /api/stats/site-distribution|site-trend|model-by-site` — 分布/趋势/模型站点

## 路由与通道

- `GET /api/routes` · `GET /api/routes/lite|summary` — 路由列表
- `POST /api/routes` · `PUT|DELETE /api/routes/:id` — 路由 CRUD
- `POST /api/routes/batch` — 批量
- `POST /api/routes/rebuild` — 重建路由
- `GET /api/routes/:id/channels` · `POST /api/routes/:id/channels` — 通道
- `PUT /api/channels/:channelId` · `DELETE /api/channels/:channelId` — 通道更新/删除
- `POST /api/routes/decision/refresh` — 刷新路由决策
- `POST /api/routes/:id/cooldown/clear` — 清除冷却

## 签到、任务、设置

- `POST /api/checkin/trigger` — 触发签到
- `POST /api/checkin/trigger/:id` — 单账号签到
- `GET /api/checkin/logs` — 签到记录
- `PUT /api/checkin/schedule` — 修改签到计划
- `GET /api/tasks` · `GET /api/tasks/:id` — 后台任务
- `GET|PUT /api/settings/runtime` — 运行时设置
- `GET /api/settings/database/runtime` · `POST /api/settings/database/test-connection|migrate` — 数据库
- `GET /api/settings/backup/export` · `POST /api/settings/backup/import` — 备份导入导出
- `GET|PUT /api/settings/backup/webdav` · `POST /api/settings/backup/webdav/export|import` — WebDAV
- `POST /api/settings/notify/test` — 测试通知
- `POST /api/settings/maintenance/clear-cache|clear-usage|factory-reset` — 维护（破坏性）
- `GET /api/settings/auth/info` — 管理认证信息
- `POST /api/settings/auth/change` — 修改管理密码

## 事件、公告、隧道

- `GET /api/events` · `GET /api/events/count` · `POST /api/events/:id/read` · `POST /api/events/read-all` · `DELETE /api/events`
- `GET /api/site-announcements` · `POST /api/site-announcements/sync`
- `GET /api/tunnel/status` · `POST /api/tunnel/enable|disable` · `PUT /api/tunnel/dashboard-access`

## OAuth

- `GET /api/oauth/providers` — 可用 OAuth 提供商
- `POST /api/oauth/providers/:provider/start` — 发起 OAuth
- `GET /api/oauth/sessions/:state` — 会话状态
- `POST /api/oauth/connections/:accountId/rebind` — 重绑
- `DELETE /api/oauth/connections/:accountId` — 断开
- `POST /api/oauth/connections/quota/refresh-batch` — 批量刷新配额
- `POST /api/oauth/route-units` · `DELETE /api/oauth/route-units/:routeUnitId` — 路由单元

## 对外代理接口（downstream key）

- `GET /v1/models` — 模型列表
- `POST /v1/chat/completions` — OpenAI 对话
- `POST /v1/completions` — 补全
- `POST /v1/messages` · `POST /v1/messages/count_tokens` — Anthropic
- `POST|GET /v1/responses` · `POST /v1/responses/compact` — Responses API
- `POST /v1/embeddings` — 向量
- `POST /v1/images/*` — 图像
- `POST /v1/videos` · `GET|DELETE /v1/videos/:id` — 视频
