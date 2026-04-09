// ────────────────────────────────────────
// Web search tool — DuckDuckGo HTML scraping + SearxNG fallback
// ────────────────────────────────────────

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

const MAX_RESULTS = 5;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function executeSearch(query: string): Promise<string> {
  const e = env();

  // Route 1: SearxNG if configured
  if (e.SEARXNG_URL) {
    return searxngSearch(query, e.SEARXNG_URL);
  }

  // Route 2: DuckDuckGo HTML scraping (always available)
  return ddgSearch(query);
}

// ── DuckDuckGo HTML search ──

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function ddgSearch(query: string): Promise<string> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `q=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return `搜索失败: DuckDuckGo 返回 ${res.status}`;

    const html = await res.text();
    const results = parseDdgHtml(html);

    if (!results.length) return `没有找到与"${query}"相关的结果。`;

    let output = `关于"${query}"的搜索结果：\n`;
    for (const r of results.slice(0, MAX_RESULTS)) {
      output += `- ${r.title}\n  ${r.snippet}\n  ${r.url}\n`;
    }
    return output;
  } catch (err) {
    logger.error({ err, query }, 'DDG search failed');
    return `搜索失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function parseDdgHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Match result blocks: each has class="result"
  const resultBlocks = html.split(/class="result\s/);

  for (const block of resultBlocks.slice(1)) { // skip before first result
    // Title: <a class="result__a" ...>TITLE</a>
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    // URL: <a class="result__url" ...>URL</a>
    const urlMatch = block.match(/class="result__url"[^>]*href="([^"]*)"/) ||
                     block.match(/class="result__url"[^>]*>([\s\S]*?)<\/a>/);
    // Snippet: <a class="result__snippet" ...>SNIPPET</a> or <td class="result__snippet">
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td)>/);

    if (titleMatch?.[1]) {
      const title = stripTags(titleMatch[1]).trim();
      let url = '';
      if (urlMatch?.[1]) {
        url = stripTags(urlMatch[1]).trim();
        if (url.startsWith('//')) url = `https:${url}`;
        // DDG encodes URLs through redirect, try to extract actual URL
        const uddg = url.match(/uddg=([^&]+)/);
        if (uddg?.[1]) url = decodeURIComponent(uddg[1]);
      }
      const snippet = snippetMatch?.[1] ? stripTags(snippetMatch[1]).trim() : '';

      if (title && (url || snippet)) {
        results.push({ title, url, snippet });
      }
    }
  }

  return results;
}

// ── SearxNG search ──

async function searxngSearch(query: string, apiUrl: string): Promise<string> {
  const url = `${apiUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return `搜索失败: SearxNG 返回 ${res.status}`;

    const data = (await res.json()) as {
      results?: Array<{ title?: string; content?: string; url?: string }>;
    };
    if (!data.results?.length) return `没有找到与"${query}"相关的结果。`;

    let result = `关于"${query}"的搜索结果：\n`;
    for (const item of data.results.slice(0, MAX_RESULTS)) {
      result += `- ${item.title ?? '无标题'}\n  ${stripTags(item.content ?? '')}\n  ${item.url ?? '#'}\n`;
    }
    return result;
  } catch (err) {
    logger.error({ err, query }, 'SearxNG search failed');
    return `搜索失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}
