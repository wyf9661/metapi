# 🔌 上游接入指南

本文档详细说明如何将不同类型的 AI 中转站接入 Metapi。

[返回文档中心](./README.md)

---

## 概述

Metapi 支持两大类上游站点：

1. **中转聚合平台** — New API / One API / OneHub / DoneHub / Veloera / AnyRouter / Sub2API 等
2. **官方 API 端点** — OpenAI / Claude (Anthropic) / Gemini (Google) 直连

每种站点类型的接入方式略有不同，本文档按站点类型分别说明。

---

## 🎯 快速接入流程

### 通用步骤

1. **登录管理后台** — 访问 `http://your-metapi-host:4000`，使用 `AUTH_TOKEN` 登录
2. **进入站点管理** — 点击左侧菜单「站点管理」
3. **添加站点** — 点击「添加站点」按钮
4. **填写站点信息** — 根据站点类型填写对应字段（见下文详细说明）
5. **添加账号** — 站点创建后，在站点详情页添加账号凭证
6. **验证连接** — 系统自动验证账号可用性并获取模型列表

---

## 📦 中转聚合平台接入

### New API

**适用平台：** New API 及其衍生版本（AnyRouter、VO-API、Super-API、RIX-API、Neo-API 等）

#### 站点配置

| 字段 | 说明 | 示例 |
|------|------|------|
| **站点名称** | 自定义名称，便于识别 | `我的 New API` |
| **站点 URL** | New API 部署地址（**不含** `/v1` 后缀） | `https://api.example.com` |
| **平台类型** | 选择 `new-api` | - |
| **代理 URL** | （可选）该站点专用代理地址 | `http://proxy.example.com:7890` |
| **使用系统代理** | 是否使用全局 `SYSTEM_PROXY_URL` | 默认关闭 |

#### 账号凭证类型

New API 支持三种凭证类型：

##### 1. 用户名密码登录（推荐AnyRouter使用）

- **适用场景：** 有完整账号权限，需要自动签到、余额查询、账号令牌管理
- **填写方式：**
  - 用户名：`your-username`
  - 密码：`your-password`
- **自动获取：** 系统自动登录并获取 Access Token 和账号令牌

##### 2. Access Token / Session Cookie

- **适用场景：** 已有登录凭证，无需密码
- **填写方式：**
  - 在「Access Token」字段填入以下任一格式：
    - Session Cookie：**（最不推荐）**
    - 可通过浏览器F12获取 ![Session Cookie 获取](./screenshots/session-cookie-f12.png)
    - 一般为如下格式：`session=MTczNjQxMjM0NXxEdi1CQUFFQ180SUFBUkFCRUFBQVB2LUNBQUVHYzNSeWFXNW5EQThBRFhObGMzTnBiMjVmZEdGaWJHVUdjM1J5YVc1bkRBSUFBQT09fGRlYWRiZWVmMTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWY=`
    - 系统访问令牌和用户ID**（推荐非Anyrouter的其他New API站点使用）**
    - ![](./screenshots/account-management.png)
- **自动解析：** 系统自动识别凭证类型并提取用户信息

##### 3. API Key（仅代理）

- **适用场景：** 仅用于模型调用，不需要余额管理、自动签到等功能
- **填写方式：**
  - 在「API Token」字段填入：`sk-xxxxxxxxxxxxxx`
- **限制：** 无法使用签到、余额刷新、账号令牌管理等功能

#### 特殊说明

**User ID 自动探测：** New API 通常需要在请求头中携带 `New-API-User` / `Veloera-User` / `voapi-user` 等字段。Metapi 会自动：

1. 从 JWT Token 中解码 User ID
2. 从 Session Cookie 中提取 User ID（支持 Gob 编码解析）
3. 通过探测常见 ID 范围验证可用性

如果以上方法都不能获取到ID，则需要用户手动获取。

**防护盾穿透：** 自动处理阿里云盾 / Cloudflare 等 JS 挑战（`acw_sc__v2` / `cdn_sec_tc`），无需手动配置。

---

### One API

**适用平台：** One API 原版及兼容分支

#### 站点配置

| 字段 | 说明 | 示例 |
|------|------|------|
| **站点名称** | 自定义名称 | `One API 主站` |
| **站点 URL** | One API 部署地址 | `https://oneapi.example.com` |
| **平台类型** | 选择 `one-api` | - |

#### 账号凭证

One API 支持与 New API 相同的三种凭证类型（用户名密码 / Access Token / API Key），配置方式相同。

---

### OneHub

**适用平台：** OneHub（One API 增强分支）

#### 站点配置

| 字段 | 说明 | 示例 |
|------|------|------|
| **站点名称** | 自定义名称 | `OneHub 站点` |
| **站点 URL** | OneHub 部署地址 | `https://onehub.example.com` |
| **平台类型** | 选择 `one-hub` | - |

#### 账号凭证

OneHub 继承 One API 的凭证体系，支持用户名密码、Access Token、API Key 三种方式。

**额外功能：** OneHub 支持 Token 分组（`token_group`），Metapi 会自动识别并保留分组信息。

---

### DoneHub

**适用平台：** DoneHub（OneHub 增强分支）

#### 站点配置

| 字段 | 说明 | 示例 |
|------|------|------|
| **站点名称** | 自定义名称 | `DoneHub 站点` |
| **站点 URL** | DoneHub 部署地址 | `https://donehub.example.com` |
| **平台类型** | 选择 `done-hub` | - |

#### 账号凭证

DoneHub 完全兼容 OneHub 的凭证体系，配置方式相同，DoneHub获取令牌位置如下图所示：![DoneHub 令牌位置](./screenshots/donehub-token.png)

---

### Veloera

**适用平台：** Veloera API 网关

#### 站点配置

| 字段 | 说明 | 示例 |
|------|------|------|
| **站点名称** | 自定义名称 | `Veloera 网关` |
| **站点 URL** | Veloera 部署地址 | `https://veloera.example.com` |
| **平台类型** | 选择 `veloera` | - |

#### 账号凭证

Veloera 基于 New API 架构，支持相同的凭证类型。特别注意：
- Veloera 需要 `Veloera-User` 请求头，Metapi 会自动添加

---

### Sub2API

**适用平台：** Sub2API 订阅制中转平台

#### 站点配置

| 字段 | 说明 | 示例 |
|------|------|------|
| **站点名称** | 自定义名称 | `Sub2API 订阅站` |
| **站点 URL** | Sub2API 部署地址 | `https://sub2api.example.com` |
| **平台类型** | 选择 `sub2api` | - |

#### 账号凭证

Sub2API 常见 JWT 短期会话机制，和传统 NewAPI 站点差异较大。按下面步骤进行添加：

首先去中转站点F12打开如下界面：

![Sub2API 认证字段示例](./screenshots/sub2api-auth-f12.png)

然后回到Metapi账号添加处：

![Sub2API Session 配置](./screenshots/sub2api-session-config.png)

1. 在「凭证模式」里选择 Session 模式，分别粘贴F12界面中的auth_token、refresh_token、token_expires_at字段进行验证，无需配置用户ID。
2. 不要使用账号密码登录，Metapi 不支持代替 Sub2API 做登录
3. Sub2API 通常为订阅制使用，不支持签到；如果你只关心代理调用，也可以直接改用 API Key 模式
4. 若 `GET /v1/models` 为空，先确认该账号下已有可用用户 API Key，Metapi 会再尝试用它发现模型

---

## 🌐 官方 API 端点接入

### OpenAI

**适用场景：** 直连 OpenAI 官方 API 或 OpenAI 兼容端点

#### 站点配置

| 字段 | 说明 | 示例 |
|------|------|------|
| **站点名称** | 自定义名称 | `OpenAI 官方` |
| **站点 URL** | OpenAI API 端点（**不含** `/v1` 后缀） | `https://api.openai.com` |
| **平台类型** | 选择 `openai` | - |
| **代理 URL** | （推荐）配置代理以访问 OpenAI | `http://proxy.example.com:7890` |

#### 账号凭证

**仅支持 API Key：**
- 在「API Token」字段填入：`sk-proj-xxxxxxxxxxxxxx`
- 不支持用户名密码登录（OpenAI 无此接口）

#### 功能限制

| 功能 | 支持情况 |
|------|----------|
| 模型列表获取 | ✅ 支持（`/v1/models`） |
| 代理调用 | ✅ 支持 |
| 余额查询 | ❌ 不支持（OpenAI 无公开接口） |
| 自动签到 | ❌ 不适用 |
| 账号令牌管理 | ❌ 不适用 |

---

### Claude (Anthropic)

**适用场景：** 直连 Anthropic Claude API

#### 站点配置

| 字段 | 说明 | 示例 |
|------|------|------|
| **站点名称** | 自定义名称 | `Claude 官方` |
| **站点 URL** | Anthropic API 端点 | `https://api.anthropic.com` |
| **平台类型** | 选择 `claude` | - |

#### 账号凭证

**仅支持 API Key：**
- 在「API Token」字段填入：`sk-ant-api03-xxxxxxxxxxxxxx`

#### 功能限制

| 功能 | 支持情况 |
|------|----------|
| 模型列表获取 | ✅ 支持（内置模型目录） |
| 代理调用 | ✅ 支持（自动转换 OpenAI ⇄ Claude 格式） |
| 余额查询 | ❌ 不支持 |
| 自动签到 | ❌ 不适用 |
| 账号令牌管理 | ❌ 不适用 |

**协议转换：** Metapi 自动处理 OpenAI 格式与 Claude Messages API 格式的双向转换，下游客户端可使用 OpenAI SDK 调用 Claude 模型。

---

### Gemini (Google)

**适用场景：** 直连 Google Gemini API

#### 站点配置

| 字段 | 说明 | 示例 |
|------|------|------|
| **站点名称** | 自定义名称 | `Gemini 官方` |
| **站点 URL** | Gemini API 端点 | `https://generativelanguage.googleapis.com` |
| **平台类型** | 选择 `gemini` | - |

#### 账号凭证

**仅支持 API Key：**
- 在「API Token」字段填入：`AIzaSyxxxxxxxxxxxxxx`

#### 功能限制

| 功能 | 支持情况 |
|------|----------|
| 模型列表获取 | ✅ 支持（`/v1beta/models`） |
| 代理调用 | ✅ 支持（自动转换 OpenAI ⇄ Gemini 格式） |
| 余额查询 | ❌ 不支持 |
| 自动签到 | ❌ 不适用 |
| 账号令牌管理 | ❌ 不适用 |

**协议转换：** Metapi 自动处理 OpenAI 格式与 Gemini `generateContent` API 格式的双向转换。

---

## 🔧 高级配置

### 站点级代理

每个站点可单独配置代理，优先级高于全局 `SYSTEM_PROXY_URL`：

```
站点专用代理 > 全局系统代理 > 直连
```

**配置方式：**
1. 在站点编辑页面填写「代理 URL」字段
2. 格式：`http://proxy-host:port` 或 `socks5://proxy-host:port`
3. 支持 HTTP / HTTPS / SOCKS5 代理

### 站点权重

**全局权重（`global_weight`）：** 影响该站点下所有通道的路由概率。

- 默认值：`1.0`
- 范围：`0.1` ~ `10.0`
- 示例：
  - 设置为 `2.0` — 该站点通道被选中的概率翻倍
  - 设置为 `0.5` — 该站点通道被选中的概率减半

**配置位置：** 站点编辑页面 → 高级设置 → 全局权重

### 外部签到 URL

**适用场景：** 某些站点的签到接口非标准路径，或需要通过外部服务触发签到。

**配置方式：**
1. 在站点编辑页面填写「外部签到 URL」
2. Metapi 会向该 URL 发送 POST 请求执行签到
3. 请求头自动携带账号凭证

---

## 🔍 站点自动检测

Metapi 支持自动识别站点类型，检测优先级如下：

### 1. URL 特征检测

根据 URL 中的关键字自动识别：

| URL 特征 | 识别为 |
|----------|--------|
| `api.openai.com` | OpenAI |
| `api.anthropic.com` | Claude |
| `generativelanguage.googleapis.com` | Gemini |
| `anyrouter` | AnyRouter |
| `donehub` / `done-hub` | DoneHub |
| `onehub` / `one-hub` | OneHub |
| `veloera` | Veloera |
| `sub2api` | Sub2API |

### 2. 页面标题检测

访问站点首页，解析 `<title>` 标签识别平台类型。

### 3. API 探测

依次尝试各平台的特征接口：
- New API：`/api/status` 返回 `system_name`
- One API：`/api/status` 返回特定结构
- OpenAI：`/v1/models` 返回模型列表

**手动指定：** 如果自动检测失败，可在添加站点时手动选择平台类型。

---

## 📊 账号健康状态

Metapi 自动追踪每个账号的健康状态：

| 状态 | 说明 | 触发条件 |
|------|------|----------|
| `healthy` | 健康 | 最近请求成功，余额充足 |
| `degraded` | 降级 | 部分模型不可用，或余额不足 |
| `unhealthy` | 不健康 | 连续失败，或凭证过期 |
| `disabled` | 已禁用 | 手动禁用或站点禁用 |

**自动恢复：** `unhealthy` 状态的账号会定期重试，成功后自动恢复为 `healthy`。

---

## 📰 站点公告

Metapi 会定期抓取已接入站点的公告，并在首次发现时写入站内通知与「站点公告」页面。

当前支持的公告来源：

- `new-api`：读取 `/api/notice` 的全站公告
- `done-hub`：读取 `/api/notice` 的全站公告
- `sub2api`：读取 `/api/v1/announcements` 的公告列表

行为约定：

1. 首次发现的公告会触发一次 Metapi 通知
2. 已经保存过的公告再次同步时只更新本地记录
3. `sub2api` 这类需要登录态的公告接口，会优先使用站点下已启用账号的会话令牌
4. 「站点公告」页面的清空操作只影响 Metapi 本地数据库

---

## 🛠️ 故障排查

### 问题：添加站点后无法获取模型列表

**可能原因：**
1. 站点 URL 填写错误（检查是否包含 `/v1` 后缀，应去除）
2. 网络不通（检查代理配置或防火墙）
3. 凭证无效（重新验证账号密码或 Token）

**解决方法：**
- 在站点详情页点击「测试连接」
- 查看「事件日志」中的错误信息
- 检查「代理日志」中的请求详情

### 问题：New API 账号提示「需要 New-API-User 头」

**原因：** 该站点是 New API 衍生版本，需要 User ID。

**解决方法：**
1. Metapi 会自动探测 User ID，通常无需手动配置
2. 如果自动探测失败，可在账号编辑页面的「额外配置」中手动填写：
   ```json
   {
     "platformUserId": 12345
   }
   ```

### 问题：签到失败

**可能原因：**
1. 凭证过期（Access Token 有效期到期）
2. 站点签到接口变更
3. 已经签到过（部分站点限制每日一次）

**解决方法：**
- 查看「签到记录」中的失败原因
- 尝试重新登录获取新凭证
- 配置「外部签到 URL」使用备用签到方式

### 问题：余额显示不准确

**原因：** 不同平台的余额单位不同。

**说明：**
- New API 系列：余额单位为「美元」，内部存储为 `quota / 500000`
- OpenAI / Claude / Gemini：官方 API 无余额查询接口，显示为 `N/A`

---

## 📝 最佳实践

### 1. 凭证选择建议

| 场景 | 推荐凭证类型 | 原因 |
|------|-------------|------|
| 个人站点，需要完整功能 | 用户名密码 | 支持自动签到、账号令牌管理 |
| 共享账号，只读权限 | Access Token | 避免密码泄露 |
| 仅用于模型调用 | API Token | 最小权限原则 |

### 2. 站点命名规范

建议使用清晰的命名规则，便于管理：

```
[平台类型] - [站点特征] - [用途]
```

示例：
- `New API - 主站 - 生产环境`
- `OneHub - 备用 - 测试`
- `OpenAI - 官方 - 高优先级`

### 3. 代理配置策略

- **国内访问 OpenAI / Claude / Gemini：** 必须配置代理
- **国内中转站：** 通常不需要代理
- **海外中转站：** 根据网络情况选择

### 4. 定期维护

- **每周检查：** 账号健康状态、余额预警
- **每月清理：** 禁用长期不可用的站点和账号
- **凭证轮换：** 定期更新 Access Token 和 API Key

---

## 🔗 相关文档

- [配置说明](./configuration.md) — 环境变量与路由参数
- [客户端接入](./client-integration.md) — 下游应用配置
- [常见问题](./faq.md) — 故障排查与优化建议

---

## 💡 提示

- 添加站点后，系统会自动发现可用模型并生成路由表，无需手动配置
- 支持同时接入多个相同类型的站点（如多个 New API 实例）
- 站点禁用后，关联的所有账号和路由通道会自动禁用
- 删除站点会级联删除所有关联账号、Token 和路由配置，请谨慎操作
