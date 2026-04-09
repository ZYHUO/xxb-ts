// ────────────────────────────────────────
// SearxNG search tool implementation
// Port of PHP ToolService::search()
// ────────────────────────────────────────

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

const MAX_RESULTS = 5;

export async function executeSearch(query: string): Promise<string> {
  const e = env();
  const apiUrl = e.SEARXNG_URL;
  if (!apiUrl) return '搜索工具未配置。';

  const url = `${apiUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;

  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; XXB-Bot/1.0)',
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return `搜索失败: 搜索引擎返回状态码 ${res.status}`;

    const data = (await res.json()) as {
      results?: Array<{ title?: string; content?: string; url?: string }>;
    };
    if (!data.results?.length) return `没有找到与 '${query}' 相关的结果。`;

    let result = `关于"${query}"的搜索结果摘要：\n`;
    for (const item of data.results.slice(0, MAX_RESULTS)) {
      result += `- 标题: ${item.title ?? '无标题'}\n  摘要: ${stripTags(item.content ?? '无摘要')}\n  链接: ${item.url ?? '#'}\n`;
    }
    return result;
  } catch (err) {
    logger.error({ err, query }, 'Search failed');
    return `搜索失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}
