# 通道后台探测（Recovery Probe）职责重构

日期：2026-07-24  
范围：`channelRecoveryProbeService` + 冷却语义 + 探测日志/连通性副作用  
不在本计划：手动站点测活 UI 大改、批量 modelAvailabilityProbe 全站扫

---

## 1. Goal

在「**真实失败冷却只能由真实成功清除**」的前提下，重新定义后台探测的**意义、触发条件、频率、副作用**，避免：

1. 探测假阳性把坏通道提前放回选路池（已部分修）
2. 冷却通道 ~30s 一轮探测造成用量/封号风险
3. 探测日志淹没真实使用日志，可用性数字失真
4. “探测还在跑但几乎无决策价值”的空转

目标态一句话：

> **冷却负责“别急着再用”；探测负责“低成本观察上游是否还活着 + 更新软信号”；只有真实流量负责“证明能干活并恢复资格”。**

---

## 2. 当前问题（基于线上事实）

### 2.1 旧逻辑（已修一半）

```
真实失败 → 短冷却
  → 后台 probe 成功 → recordProbeSuccess 清冷却  ← 错
  → 通道再入池 → 真实再失败 → 循环
```

已改为：probe 成功**不再清冷却**。

### 2.2 修完后的空心化

若探测只写日志、不清冷却、不改选路，则当前实现近似：

- 每 30s sweep
- 冷却通道最快 30s 探一次
- 活跃通道 5min
- 每轮最多 4 通道 / 并发 1
- 成功：几乎 no-op（return）
- 失败：也不延长冷却

→ **成本仍在，决策价值接近 0。** 这就是用户质疑的点，正确。

### 2.3 探测 ≠ 真实可用（不可抹平）

| 维度 | 轻量 probe | 真实代理 |
|---|---|---|
| Prompt | 极短 | 可很长 / tools |
| Endpoint | 常单路径 | chat→responses 级联 |
| 流式/首包 | 非流、12s | 流式、15s 首包等 |
| 失败语义 | model 是否存在/通 | 业务是否扛得住 |

因此：**禁止再用 probe 成功推翻真实失败冷却**（硬约束，保留）。

---

## 3. 原则（产品语义）

### P0 硬约束

1. **真实失败冷却**：仅 `recordFailure` 写入；仅**真实** `recordSuccess` 全清。
2. **Probe 不得**调用会清冷却 / 清 consecutiveFail 的成功路径（保持现状）。
3. Probe 请求必须可识别：`client_family=probe`，用量与告警可剔除。

### P1 探测仍有价值的场景（保留理由）

探测只回答弱问题，不回答强问题：

| 问题 | 该不该用 probe | 动作 |
|---|---|---|
| Key/模型是否彻底 404/鉴权挂？ | 是 | 标 `connectivity=false` / 软降权 |
| 冷却到期前，上游是否仍全死？ | 可选 | 仅观测，**不提前放行** |
| 冷却到期后第一次真实请求前，预热？ | 否（价值低、假阳性高） | 不靠 probe 清冷却 |
| 真实业务是否稳定？ | 否 | 只信真实流量 |

### P2 频率与安全

- 默认**远低于** 30s/通道。
- 失败/成功都要**退避**，避免对 free 站“探到封号”。
- 全局预算：每站 / 每 Key 每小时 probe 上限。

---

## 4. 推荐目标架构

把“恢复探测”拆成三层，而不是一个 30s 万能循环。

```
┌─────────────────────────────────────────────┐
│ A. 真实流量环（唯一恢复资格来源）              │
│    recordFailure → cooldown                  │
│    recordSuccess → clear cooldown            │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│ B. 软信号探测（可选、低频）                    │
│    probe → connectivity / probe_score only   │
│    永不 clear cooldown                       │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│ C. 运维测活（手动 / 批量开关）                 │
│    probeSiteModels / modelAvailabilityProbe  │
│    改可用性/禁用模型，仍不自动 clear 路由冷却   │
└─────────────────────────────────────────────┘
```

### 4.1 冷却生命周期（唯一真相）

```
eligible
  --真实失败--> cooling (until T)
  --真实成功--> eligible
  --到时 T--> eligible   // 自然到期，不需要 probe 批准
```

Probe **不改变**状态机边。

### 4.2 Probe 允许的副作用（白名单）

允许：

1. 写 `proxy_logs`（`client_family=probe`，下游 path=`internal://model-probe`）
2. 更新 `model_availability.connectivity` / 最近 probe 延迟（软信号）
3. 可选：写入 `route_channels.last_probe_at / last_probe_status`（新字段或 JSON extra）
4. 可选：探测**失败且**是 definitive unsupported（model not found）时，**延长**冷却或禁用模型——这是“更坏”方向，安全

禁止：

1. `recordProbeSuccess` 清冷却 / 清 fail ladder
2. 用 probe 成功把通道权重拉回“全新健康”
3. 对 provider-directed quota cooldown 做探测（已有 skip，保留）

### 4.3 若还要“加速恢复”，正确做法（可选 P2，默认不做）

不要用轻量 probe 清冷却。若产品坚持“探活后可提前试”：

- **缩短剩余冷却，而不是清零**（例如最多砍到 1 次真实试探窗口）
- 且要求：**连续 N 次 probe 成功 + 冷却已过半 + 非 5xx 风暴窗口**
- 第一次真实请求仍用**影子权重**（probe-only health 不能当 primary 满分）

默认建议：**不做加速恢复**，冷却自然到期最简单、最少假阳性。

---

## 5. 频率与预算（建议默认）

替换当前常量：

| 项 | 现在 | 建议默认 |
|---|---|---|
| Sweep 周期 | 30s | **60–120s**（只扫候选，不是每通道都打） |
| 冷却通道再探 | 30s | **5–15 min**，且冷却剩余时间 > 窗口才探 |
| 活跃通道再探 | 5 min | **15–30 min** 或**默认关闭** |
| 每轮 batch | 4 | **2** |
| 并发 | 1 | **1**（保持） |
| 同 channel 失败退避 | 无 | 失败后 **×2**，上限 1h |
| 同 site×key 小时预算 | 无 | 如 **20–40 次/小时**（可配置） |

**冷却通道探测触发条件（更严）：**

仅当同时满足才探：

1. `cooldown_until > now`（仍在冷却）
2. 距上次 probe ≥ `COOLDOWN_RECHECK`（5–15min）
3. 冷却剩余时间 **> 2min**（快到期的不必再探，等真实流量）
4. 非 provider-directed quota cooldown
5. 未超 site/key 小时预算

**活跃通道探测：**

- 默认建议 **关闭**，或仅当 `last_real_success` 很久且有真实流量预期时
- 避免对健康站无意义刷量

---

## 6. 日志与观测

### 6.1 使用日志

- 保留 probe 行便于排障，但：
  - 下游 path 写 `internal://model-probe`（避免“未记录”）
  - Dashboard 可用性 / 消耗 KPI：**默认排除 probe** 或单独一行「探测流量」
  - 列表可筛 `client=probe` / 默认隐藏 probe

### 6.2 运维可见

通道或站点上展示：

- 最近真实成功/失败时间
- 冷却剩余
- 最近 probe 状态（仅信息）
- 文案明确：**探测成功 ≠ 已恢复路由资格**

---

## 7. 分阶段落地

### Phase 0 — 立刻（低风险，强烈建议）

**目标：** 停止空转烧额度，语义自洽。

1. 冷却再探间隔：30s → **10 min**（或 5 min 起步）
2. 活跃通道探测：**默认关**（或 30 min）
3. Sweep：30s → **60s**
4. Batch：4 → **2**
5. 保持：probe 成功**绝不** clear cooldown
6. 下游 path：`internal://model-probe`
7. 文档/技能：写清“探测假阳性 vs 真实冷却”

**验收：**

- 单冷却通道 probe ≤ 6 次/小时
- 真实失败后冷却能撑满到期时间，不被 probe 打断
- 大喵喵类站不再出现“每分钟一条 Model Probe”刷屏

### Phase 1 — 让探测重新有意义（中）

1. Probe 结果只写 soft signal：
   - `connectivity` true/false/null + `checked_at`
   - 选路已有 soft factor 时接入（false 降权，不硬踢光）
2. Definitive probe 失败（model_not_found / 明确 unsupported）：
   - 可 `site_disabled_models` 或拉长该 channel 冷却（**惩罚方向**）
3. 成功 probe：只更新 latency 观测，**不** boost 到“已验证业务可用”
4. 使用日志默认过滤 probe；仪表盘真实成功率不含 probe

**验收：**

- 假阳性成功站：真实冷却仍完整
- 真死模型：探测失败后 soft 降权或禁用，真实流量少撞

### Phase 2 — 可选产品增强（高，需你拍板）

仅当明确需要“加速恢复”时：

1. 连续 N 次 probe 成功 → **缩短**剩余冷却（非清零），上限一次
2. 或「到期后的第一次真实请求」用 canary 权重
3. 配置项：
   - `channelRecoveryProbeEnabled`
   - `cooldownProbeIntervalMs`
   - `activeProbeEnabled`
   - `probeHourlyBudgetPerSite`
   - `probeMayShortenCooldown`（默认 false）

**默认建议 Phase 2 的 shorten 关闭。**

---

## 8. 代码落点（实现时）

| 文件 | 改动 |
|---|---|
| `src/server/services/channelRecoveryProbeService.ts` | 间隔/候选条件/预算/活跃探测开关；成功分支只写 soft signal |
| `src/server/services/runtimeModelProbe.ts` | `downstreamPath: internal://model-probe`；可选减少 usage 计费噪音 |
| `src/server/services/tokenRouter.ts` | 保持 `recordProbeSuccess` 不用于 recovery；或拆 `recordProbeObservation` |
| `src/server/services/routeConnectivityLookup.ts` / scoring | 消费 probe 更新的 connectivity |
| `src/server/services/usageAggregationService.ts` / dashboard | KPI 默认排除 probe（可配置） |
| `src/web/pages/ProxyLogs.tsx` | 默认隐藏 probe 或角标；path 展示 |
| tests | recovery 间隔、不清冷却、预算、soft signal |

---

## 9. 决策表（请你拍板）

| # | 问题 | 建议默认 |
|---|---|---|
| D1 | 冷却中还要不要后台探？ | **要，但 5–15min 且有预算**；不是 30s |
| D2 | 活跃健康通道还要不要探？ | **默认关** |
| D3 | probe 成功能否缩短冷却？ | **否**（Phase 2 可选） |
| D4 | probe 失败能否加长冷却/禁用模型？ | **definitive 失败可以** |
| D5 | probe 是否进可用性 KPI？ | **默认不进** |
| D6 | 使用日志是否默认显示 probe？ | **可筛，默认可隐藏** |

---

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 降频后更晚发现上游恢复 | 冷却到期后真实流量自然试；可接受 |
| 完全关掉探测丢 soft 信号 | Phase 1 保留低频 + connectivity |
| 改 KPI 排除 probe 后可用性“变差/变好” | 发布说明：此前 probe 污染了成功率 |
| free 站仍封号 | 小时预算 + 失败退避 + 活跃探测关 |

---

## 11. 建议执行顺序（你确认后开工）

1. **Phase 0 降频 + 语义钉死**（半天内，收益最大）
2. **日志/KPI 去污染**（和 Phase 0 可同批）
3. Phase 1 soft signal（视需要）
4. Phase 2 加速恢复（默认不做）

---

## 12. 一句话结论

- **现在这种“成功冷却都不清、却还 30s 猛探”的后台探测，意义不足，还烧额度。**
- 探测仍应存在，但角色从「复活开关」降级为「低频软观测 / 确认是否彻底挂死」。
- **恢复资格只认真实流量；冷却自然到期即可再试。**

确认 D1–D6 后按 Phase 0 落地。
