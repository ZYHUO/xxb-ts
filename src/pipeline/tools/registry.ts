// ────────────────────────────────────────
// Tool Registry — Vercel AI SDK tool definitions
// ────────────────────────────────────────

import { z } from 'zod';
import { tool } from 'ai';
import type { Tool } from 'ai';
import { executeSearch } from './search.js';
import { executeFetch } from './web-fetch.js';
import { executeIpQuality } from './ip-quality.js';
import { addTimer, listTimers, deleteTimer } from './timer.js';
import { queryBotKnowledge } from './bot-knowledge.js';
import { env } from '../../env.js';

export function buildToolSet(chatId: number, userId: number) {
  const e = env();
  const tools: Record<string, Tool> = {};

  // SEARCH — web search (DuckDuckGo fallback, SearxNG if configured)
  tools.SEARCH = tool({
    description: '搜索互联网获取最新信息。当用户询问你不确定的事实、新闻、或需要实时数据时使用。',
    parameters: z.object({
      query: z.string().describe('搜索查询关键词'),
    }),
    execute: async ({ query }) => executeSearch(query),
  });

  // FETCH — fetch a web page (always available via direct fetch)
  tools.FETCH = tool({
    description: '抓取并读取指定URL的网页内容。当用户分享链接或需要读取特定网页时使用。',
    parameters: z.object({
      url: z.string().url().describe('要抓取的网页URL'),
    }),
    execute: async ({ url }) => executeFetch(url),
  });

  // IP_QUALITY — IP address quality check
  if (e.IP_QUALITY_API_URL) {
    tools.IP_QUALITY = tool({
      description: '查询IP地址或域名的质量信息，包括地理位置、ISP、是否为代理等。',
      parameters: z.object({
        ip: z.string().describe('要查询的IP地址或域名'),
      }),
      execute: async ({ ip }) => executeIpQuality(ip),
    });
  }

  // ADD_TIMER — create a timer/reminder
  if (e.TIMER_API_URL) {
    tools.ADD_TIMER = tool({
      description: '创建定时提醒。支持一次性提醒和循环定时任务。',
      parameters: z.object({
        name: z.string().describe('定时器名称'),
        cron_expression: z.string().describe('Cron表达式，如 "0 8 * * *" 表示每天8点'),
        one_time: z.boolean().default(false).describe('是否为一次性定时器'),
        message: z.string().optional().describe('提醒消息内容'),
      }),
      execute: async (params) => addTimer({ ...params, chatId, userId }),
    });
  }

  // LIST_TIMERS
  if (e.TIMER_API_URL) {
    tools.LIST_TIMERS = tool({
      description: '列出当前群组的所有活跃定时器。',
      parameters: z.object({}),
      execute: async () => listTimers(chatId),
    });
  }

  // DELETE_TIMER
  if (e.TIMER_API_URL) {
    tools.DELETE_TIMER = tool({
      description: '删除指定ID的定时器。',
      parameters: z.object({
        id: z.string().describe('要删除的定时器ID'),
      }),
      execute: async ({ id }) => deleteTimer(id),
    });
  }

  // BOT_KNOWLEDGE — local tool, always available
  tools.BOT_KNOWLEDGE = tool({
    description: '查询本群其他bot的知识。传入bot用户名查看该bot信息，或传"list"列出所有已知bot。',
    parameters: z.object({
      query: z.string().describe('Bot用户名（不含@）或 "list"'),
    }),
    execute: async ({ query }) => queryBotKnowledge(chatId, query),
  });

  return tools;
}
