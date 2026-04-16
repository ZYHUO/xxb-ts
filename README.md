<div align="center">

# 🐱 xxb-ts 啾咪囝

**Telegram AI 群聊喵娘机器人 — TypeScript**

一只会思考、会回嘴、还会跟群友互动的 AI 群聊机器人。

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![grammy](https://img.shields.io/badge/grammy-Bot_Framework-009DC4)](https://grammy.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](#english) · [中文](#中文)

</div>

---

## 中文

### ✨ 特性

**核心 AI**
- 🧠 **三级判断管线** — L0 本地规则 → L1 微型 AI → L2 完整 AI（扩展上下文窗口），智能决定是否回复
- 💬 **多条回复** — AI 可一次性回复多个人（JSON 数组格式），并行发送，自动兼容单条回复
- 🔄 **流式回复** — 打字中效果，逐段更新消息，用户体验流畅
- 🛠️ **工具调用** — 网页搜索（xAI Grok / SearxNG）、网页抓取、IP 查询、定时器
- 🎯 **多模型路由** — Judge / Reply / Reply Pro / Reply Max / Vision / Summarize 分配不同模型
- 🏎️ **Hedged Request** — 主模型超时自动发备用请求，谁快用谁（可关闭省 token）
- 🧭 **Direct / Planned 双路径** — 简单消息走 direct 快速回复，复杂任务走 planned 路径（planner → tool executor → final writer）

**群组功能**
- 👥 **群成员花名册** — 自动追踪所有群成员的 username ↔ 显示名，注入 AI 上下文
- 🤖 **Bot 交互知识库** — 记录群里其他 bot 的行为，AI 自动生成摘要，回复时注入知识
- 🚫 **智能 Bot-to-Bot 屏蔽** — 有人类在场时不和其他 bot 聊天，无人时限制 1 次回复
- ✅ **每日签到** — `/checkin` 连续签到、排名、AI 自由发挥奖励内容
- 📋 **群聊白名单** — 审批制入群，AI 辅助审核，Master 通知
- 🔇 **自然语言禁言** — 说「闭嘴」「闭嘴 30 分钟」即可禁言，支持定时自动解除、直接 @bot 解除临时禁言
- 📝 **用户偏好记忆** — 「帮我记住 xxx」「忘掉 xxx」，AI 回复时自动注入用户偏好
- 📨 **DM 转发** — 私聊 bot 可转发消息到群聊，支持多群选择
- 🔁 **自我反思** — 追踪回复效果（被回复/被忽略），定期 AI 总结经验教训

**基础设施**
- 📦 **BullMQ 消息队列** — Redis 支撑的高并发处理（可配置并发数），同一 chat 内 AI 生成阶段并行
- 🗃️ **双存储** — Redis（上下文、缓存、速率限制）+ SQLite（持久化、知识库、追踪）
- 🧲 **ChromaDB 长期记忆** — 语义搜索，自动向量化群聊消息
- 📊 **Admin Mini App** — Telegram WebApp HMAC 认证，运行时配置管理
- ⏰ **Cron 定时任务** — 模型健康检查、用户画像同步、空闲主动消息、数据清理（并发保护）
- 🔐 **安全防护** — SSRF 防护、webhook constant-time 验证、速率限制、Redis Lua 原子操作、去重锁

### 🏗️ 架构

```
Telegram Update
  │
  ▼
grammy Bot ──→ Formatter ──→ Context (Redis)
  │                              │
  │                    Judge Pipeline (L0→L1→L2)
  │                       │              │
  │                    IGNORE    REPLY (direct / planned)
  │                                      │
  │                              BullMQ Queue
  │                                      │
  │                              Reply Pipeline
  │                              ├─ 4-Way Context Retrieval
  │                              │   ├─ Recent Window
  │                              │   ├─ Thread Trace (reply chain)
  │                              │   ├─ Entity Mentions
  │                              │   └─ Semantic (ChromaDB)
  │                              ├─ Direct Path: 5-Layer Prompt → AI → Reply
  │                              ├─ Planned Path: Planner → Tool Executor → Final Writer
  │                              ├─ Multi-Reply Parser + Parallel Send
  │                              └─ Stale Reply Suppression
  │
  ├─ Mute System (soft/hard/timed, auto-expire)
  ├─ DM Relay (private → group forwarding)
  ├─ Member Registry (Redis Hash)
  ├─ Bot Interaction Tracker (SQLite)
  ├─ User Profile Sync (AI-powered)
  ├─ Outcome Tracker + Self-Reflection
  ├─ Rate Limiter (Redis Lua)
  ├─ Dedup Lock (Redis NX)
  └─ Allowlist Guard

Hono HTTP Server
  ├─ /health
  ├─ /miniapp_api (Admin)
  └─ /webhook (constant-time secret verification)
```

### 📁 项目结构

```
src/
├── index.ts              # 入口 — 启动 bot + API + worker + cron
├── env.ts                # Zod 环境变量校验 (40+ 参数)
├── admin/                # Hono Admin API + HMAC-SHA256 认证
├── ai/                   # AI 调用层
│   ├── provider.ts       #   Vercel AI SDK 统一调用
│   ├── fallback.ts       #   回退链 + hedged request (Promise.any)
│   ├── labels.ts         #   模型路由配置
│   └── token-counter.ts  #   tiktoken 计算
├── allowlist/            # 群聊白名单 — 审批 + AI 审核
├── bot/                  # grammy bot
│   ├── handlers/         #   消息处理 + 成员事件
│   ├── middleware/        #   白名单 + 速率限制
│   └── sender/           #   流式发送 + Telegram API
├── cache/                # 分层缓存 (LRU + Redis)
├── cron/                 # 定时任务 (node-cron, 并发保护)
├── db/                   # Redis (ioredis) + SQLite (better-sqlite3)
├── knowledge/            # 知识库管理 + 贴纸系统
├── memory/               # ChromaDB 长期语义记忆
├── pipeline/             # 核心消息管线
│   ├── context/          #   上下文管理 + 压缩 + 4路检索
│   ├── judge/            #   三级判断 (规则 + micro + full AI)
│   ├── planner/          #   Planned 路径 (planner → executor)
│   ├── reply/            #   回复生成 + 解析 + prompt构建
│   ├── dm-relay/         #   DM 转发系统
│   └── tools/            #   工具系统 (7种工具)
├── queue/                # BullMQ 队列 + per-chat lock
├── shared/               # 类型 + 日志 (pino) + 配置
├── startup/              # 启动所有权协调 (多进程)
└── tracking/             # 活跃度 + 用户画像 + 结果追踪 + 自我反思
prompts/                  # AI Prompt 模板 (Markdown)
├── identity/             #   人格定义
├── safety/               #   安全护栏
├── contract/             #   输出格式 (JSON Schema)
├── style/                #   语调风格
├── task/                 #   任务指令 (reply, judge, planner, vision...)
└── system/               #   系统级 prompt (摘要等)
migrations/               # SQLite 迁移脚本 (0001-0011)
scripts/                  # 迁移 + 部署脚本
tests/                    # vitest 单元测试 (38 files, 336 tests)
```

### 🛠️ 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Node.js 22+ / TypeScript 5 |
| Bot 框架 | [grammy](https://grammy.dev/) |
| AI SDK | [Vercel AI SDK](https://sdk.vercel.ai/) + @ai-sdk/openai |
| HTTP 框架 | [Hono](https://hono.dev/) |
| 消息队列 | [BullMQ](https://bullmq.io/) (Redis) |
| 数据库 | SQLite ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3), WAL mode) |
| 缓存/队列 | Redis ([ioredis](https://github.com/redis/ioredis)) |
| 日志 | [pino](https://getpino.io/) |
| 校验 | [zod](https://zod.dev/) |
| Token 计算 | [tiktoken](https://github.com/openai/tiktoken) |
| 构建 | [tsup](https://tsup.egoist.dev/) |
| 测试 | [vitest](https://vitest.dev/) |
| 部署 | Docker / PM2 |

### 🚀 快速开始

#### 前置要求

- Node.js ≥ 22
- Redis ≥ 7
- Telegram Bot Token（从 [@BotFather](https://t.me/BotFather) 获取）
- OpenAI 兼容 API 密钥（OpenAI / Google Gemini / Anthropic / 自建代理等）

#### 安装

```bash
git clone https://github.com/zhongyang001-tech/xxb-ts.git
cd xxb-ts
npm install
cp .env.example .env
# 编辑 .env，填入你的 Bot Token 和 AI API 配置
```

#### 从 PHP 版 (xxb) 迁移数据

- **群组知识库**：将 PHP `paths.knowledge_base` 目录下各 `{chatId}.md` 复制到本项目的 `KNOWLEDGE_BASE_DIR`（默认 `./data/knowledge`）。全局永久知识仍使用 `prompts/knowledge/permanent.md`（与 PHP 的 `permanent_knowledge.md` 可手工合并或择一维护）。
- **双写禁忌**：若 TS 与 PHP 暂时共用同一知识库目录，只应在一侧启用 **定时知识库同步**（`KNOWLEDGE_CRON_CHAT_IDS` + cron）；避免两侧同时跑 `cron_long_term` 与本项目的 `knowledge-sync`。
- **人设**：可选将 PHP `persona_path/{userId}.txt` 复制为 `prompts/persona/{userId}.txt` 或 `.md`（或通过 `PERSONA_DIR` 指向原目录）。

#### 开发

```bash
npm run dev        # tsx watch 热重载
npm run build      # 生产构建
npm run start      # 启动生产服务
npm run test       # vitest 运行测试
npm run lint       # ESLint 检查
```

#### Docker 部署

```bash
docker compose up -d    # 启动 Redis + Bot
```

#### systemd 部署

```bash
npm run build
npm run build:miniapp
sudo ./scripts/install-systemd.sh
sudo systemctl restart xxb-ts
sudo systemctl status xxb-ts
```

常用命令：

```bash
sudo systemctl restart xxb-ts
sudo systemctl stop xxb-ts
sudo systemctl status xxb-ts
journalctl -u xxb-ts -f
```

#### PM2 部署

```bash
npm run build
pm2 start ecosystem.config.cjs --env production
```

PM2 仅建议作为备用手动方案保留；正式常驻运行优先使用 systemd。

### ⚙️ 配置

所有配置通过环境变量管理，参见 [`.env.example`](.env.example)。核心参数：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BOT_TOKEN` | Telegram Bot Token | (必填) |
| `AI_BASE_URL` | AI API 地址 (OpenAI 兼容) | (必填) |
| `AI_API_KEY` | AI API 密钥 | (必填) |
| `AI_MODEL_REPLY` | 回复用模型 | `gpt-4o-mini` |
| `AI_MODEL_JUDGE` | 判断用模型（建议轻量） | `gpt-4o-mini` |
| `REDIS_URL` | Redis 连接地址 | `redis://127.0.0.1:6379/0` |
| `HEDGE_DELAY_MS` | Hedged request 延迟（0=关闭） | `2000` |
| `CONTEXT_MAX_LENGTH` | Redis 上下文最大消息数 | `600` |
| `BOT_NICKNAMES` | Bot 昵称（逗号分隔） | `xxb,啾咪囝` |
| `MASTER_UID` | 主人 Telegram UID | `0` |
| `ALLOWLIST_ENABLED` | 启用群聊白名单 | `false` |

### 📊 Prompt 五层系统

AI 回复质量由 5 层 prompt 协同控制：

| 层级 | 文件 | 用途 |
|------|------|------|
| L1 Identity | `prompts/identity/persona.md` | 人格定义（性格、身份关系、行为边界） |
| L2 Safety | `prompts/safety/guardrails.md` | 安全护栏（拒绝有害内容、防注入） |
| L3 Contract | `prompts/contract/reply-schema.json` | JSON Schema 输出格式约束 |
| L4 Style | `prompts/style/tone.md` | 语调风格（短句、群聊风格） |
| L5 Task | `prompts/task/reply.md` | 任务指令（单条/多条回复规则） |

Prompt 文件热缓存，修改后重启即生效，无需重新构建。

### 🔐 安全特性

- **Telegram WebApp HMAC-SHA256 认证** — constant-time 比较防时序攻击
- **SSRF 防护** — 私有 IP / DNS 重绑定检查
- **路径遍历防护** — fileUniqueId 正则校验
- **Redis Lua 原子操作** — 速率限制 + 上下文修剪无竞态
- **NX 去重锁** — 提交 + 结果双重去重
- **API Key 剥离** — 前端响应永远不暴露密钥
- **响应体限制** — web-fetch 工具 512KB 上限防内存溢出

### 🔧 工具系统

Bot 可在回复时调用以下工具：

| 工具 | 说明 |
|------|------|
| `WEB_SEARCH` | 网页搜索（xAI Grok / SearxNG / DuckDuckGo） |
| `WEB_FETCH` | 抓取网页内容（HTML→文本） |
| `BOT_KNOWLEDGE` | 查询群组 bot 知识库 |
| `IP_QUALITY` | IP 地址质量/风险查询 |
| `SET_TIMER` | 设置定时提醒 |
| `LIST_TIMERS` | 列出当前定时器 |
| `DELETE_TIMER` | 删除定时器 |

---

## English

### Overview

xxb-ts (啾咪囝) is a Telegram group chat AI bot written in TypeScript. It acts as an opinionated, cat-girl-themed group member that can:

- **Intelligently decide** when to reply using a 3-level judge pipeline (local rules → micro AI → full AI with expanded context)
- **Reply to multiple people** in a single trigger using JSON array output format, sent in parallel
- **Route between direct and planned paths** — simple messages get fast direct replies, complex tasks go through planner → tool executor → final writer
- **Call tools** — web search (xAI Grok), web fetch, IP lookup, timers
- **Stream responses** with typing indicators and progressive message updates
- **Mute via natural language** — users say "shut up" or "shut up for 30 minutes" for timed auto-expiring mutes
- **Track group members** with username ↔ display name mapping, injected into AI context
- **Learn about other bots** by recording their interactions and auto-generating knowledge digests
- **Self-reflect** on reply effectiveness — tracks outcomes (replied-to vs ignored) and periodically generates lessons learned
- **Handle concurrency** via BullMQ job queue backed by Redis, with per-chat locking that allows parallel AI generation

### Key Design Decisions

- **AI-provider agnostic** — Uses [Vercel AI SDK](https://sdk.vercel.ai/) with OpenAI-compatible endpoints. Works with OpenAI, Google Gemini, Anthropic, or any compatible proxy.
- **Dual storage** — Redis for hot data (context, rate limits, member registry) + SQLite for cold data (knowledge, tracking, checkins).
- **Long-term memory** — ChromaDB for semantic search over past conversations.
- **5-layer prompt system** — Identity, Safety, Contract (JSON Schema), Style, and Task layers compose the system prompt. All prompts are Markdown files, editable without rebuilding.
- **4-way context retrieval** — Recent window + reply thread trace + entity mentions + semantic search (ChromaDB), merged and token-budget-capped.
- **Dual reply paths** — Direct path for fast simple replies, Planned path (planner → tool executor → final writer) for complex tasks requiring tools.
- **Hedged requests** — Primary + backup model race via `Promise.any`, preserving original errors on failure.
- **Graceful shutdown** — BullMQ worker drains active jobs before the bot instance is destroyed.

### Quick Start

```bash
git clone https://github.com/zhongyang001-tech/xxb-ts.git
cd xxb-ts
npm install
cp .env.example .env
# Edit .env with your Bot Token and AI API credentials
npm run build && npm start
```

Or with Docker:

```bash
docker compose up -d
```

See the [Chinese section](#中文) for detailed configuration and architecture documentation.

### Tech Stack

Node.js 22+ · TypeScript · grammy · Vercel AI SDK · Hono · BullMQ · SQLite · Redis · pino · zod · tiktoken · tsup · vitest · Docker / PM2

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
