# xxb-ts 啾咪囝

> Telegram AI 聊天机器人 — 从 PHP 重写为 TypeScript

一只会思考、会回嘴、偶尔还会贴贴纸的 Telegram 群聊 AI 机器人。

## ✨ 特性

- **多模型路由** — 按用途分配模型（Micro/Fast/Main），运行时可热切换
- **三级判断管线（Judge Pipeline）** — L0 本地规则 → L1 微型 AI → L2 完整 AI，自动决定是否回复
- **流式回复** — 打字中效果，逐段更新消息
- **工具调用** — 搜索（SearxNG）、网页抓取、IP 查询、机器人知识库
- **贴纸系统** — SQLite 驱动的情绪标签匹配，加权随机选择
- **BullMQ 消息队列** — Redis 支撑的并发处理（默认 20 并发）
- **群聊白名单** — 审批制入群，AI 辅助审核，Master 通知
- **Admin Mini App** — Telegram WebApp HMAC 认证，运行时配置管理
- **完整的安全防护** — SSRF 防护、路径遍历校验、速率限制、去重锁

## 🏗️ 架构

```
Telegram
  │
  ▼
grammy Bot ──→ Judge Pipeline (L0→L1→L2)
  │                │
  │           ┌────┴────┐
  │           │ IGNORE  │  REPLY / REPLY_PRO
  │           └─────────┘        │
  │                              ▼
  │                     BullMQ Queue
  │                              │
  │                              ▼
  │                     Reply Pipeline
  │                     ├─ Context (Redis)
  │                     ├─ Prompt Builder (5 层)
  │                     ├─ Tool Executor
  │                     ├─ Streaming Sender
  │                     └─ Sticker Matcher
  │
  ├─ Rate Limiter (Lua atomic)
  ├─ Dedup (Redis NX)
  └─ Allowlist Guard

Admin Mini App (Hono)
  ├─ HMAC-SHA256 Auth
  ├─ 模型路由管理
  ├─ 白名单管理
  └─ 健康检查
```

## 📁 项目结构

```
src/
├── index.ts              # 入口 — 启动 bot + API + worker + cron
├── env.ts                # Zod 环境变量校验
├── admin/                # Hono Admin API + 认证
├── ai/                   # AI 调用层 — 模型路由 + 回退 + 用量
├── allowlist/            # 群聊白名单 — 审批 + AI 审核
├── bot/                  # grammy bot — handler + middleware
├── cache/                # 内存缓存 (LRU)
├── cron/                 # 定时任务 — 清理 + 调度
├── db/                   # Redis + SQLite 连接
├── knowledge/            # 知识库 — 贴纸 + 机器人知识
├── pipeline/             # 核心管线
│   ├── context/          #   上下文管理 (Redis list, Lua atomic)
│   ├── judge/            #   三级判断 (L0 规则 + L1/L2 AI)
│   ├── reply/            #   回复生成 + 解析 + 去重
│   └── tools/            #   工具系统 (search, web-fetch, etc.)
├── queue/                # BullMQ 队列 — producer + worker
├── shared/               # 共享类型 + 日志 (pino) + tiktoken
└── tracking/             # 活跃度追踪 + 模型健康
scripts/
├── migrate-context.ts    # PHP→TS 上下文迁移
├── migrate-sticker.ts    # PHP→TS 贴纸迁移
├── migrate-allowlist.ts  # 白名单迁移
└── cutover.sh            # 生产切换/回滚脚本
```

## 🛠️ 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Node.js 22+ / TypeScript 5 |
| Bot 框架 | grammy |
| AI 调用 | Vercel AI SDK + @ai-sdk/openai |
| HTTP API | Hono |
| 消息队列 | BullMQ (Redis) |
| 持久化 | SQLite (better-sqlite3, WAL) |
| 缓存 | Redis (ioredis) |
| 日志 | pino |
| 校验 | zod |
| Token 计算 | tiktoken |
| 构建 | tsup |
| 测试 | vitest |
| 部署 | Docker + PM2 |

## 🚀 快速开始

### 前置要求

- Node.js ≥ 22
- Redis ≥ 7
- Telegram Bot Token (`@BotFather`)
- AI API 密钥 (OpenAI / Anthropic / Google 等)

### 安装

```bash
git clone <repo-url> xxb-ts
cd xxb-ts
npm install
cp .env.example .env
# 编辑 .env 填入你的配置
```

### 开发

```bash
npm run dev      # tsup watch + 自动重启
npm run test     # vitest 运行全部 244 测试
npm run build    # 生产构建到 dist/
npm run start    # 启动生产服务
```

### Docker 部署

```bash
docker compose up -d
```

### 从 PHP 版本迁移

```bash
# 1. 迁移上下文
npx tsx scripts/migrate-context.ts

# 2. 迁移贴纸
npx tsx scripts/migrate-sticker.ts

# 3. 生产切换
bash scripts/cutover.sh --go-live
```

## 📊 Prompt 五层系统

| 层级 | 文件 | 用途 |
|------|------|------|
| L1 Identity | `persona.md` | 人格定义 |
| L2 Safety | `guardrails.md` | 安全护栏 |
| L3 Contract | `reply-schema.json` | 输出格式约束 |
| L4 Style | `tone.md` | 语调风格 |
| L5 Task | `reply.md` / `reply-pro.md` | 任务指令 |

## 🔐 安全特性

- Telegram WebApp HMAC-SHA256 认证 (constant-time 比较)
- SSRF 防护 — 私有 IP/DNS 解析检查
- 路径遍历防护 — fileUniqueId 正则校验
- Redis Lua 原子操作 — 速率限制 + 上下文修剪无竞态
- NX 去重锁 — 提交 + 结果双重去重
- API Key 剥离 — 前端响应永远不暴露密钥
- 512KB 响应体限制 — web-fetch 工具防内存溢出

## 📈 项目统计

- **77** 源文件 / **23** 测试文件
- **~6400** 行 TypeScript 代码
- **244** 单元测试全部通过
- **46** 个 bug 在 7 轮代码审查中发现并修复

## 📄 License

Private — All rights reserved.
