// ────────────────────────────────────────
// Web page fetch tool implementation
// Port of PHP ToolService::fetchUrl()
// ────────────────────────────────────────

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import { assertUrlSsrfSafe, fetchUrlPinned } from './ssrf.js';

const MAX_OUTPUT = 3200;
const MAX_FETCH_BYTES = 512 * 1024; // 512KB max download
const MAX_GATEWAY_REDIRECTS = 8;

async function fetchWithRedirectGuard(
  startUrl: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
): Promise<{ ok: boolean; status: number; headers: Headers; text: string }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_GATEWAY_REDIRECTS; hop++) {
    assertUrlSsrfSafe(current);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: init.headers,
      signal: init.signal,
    });

    if (res.status >= 300 && res.status < 400) {
      await res.arrayBuffer().catch(() => {});
      const loc = res.headers.get('location');
      if (!loc) {
        return { ok: res.ok, status: res.status, headers: res.headers, text: '' };
      }
      current = new URL(loc, current).href;
      continue;
    }

    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text: await readBodyLimitedResponse(res, MAX_FETCH_BYTES),
    };
  }
  throw new Error('Too many redirects');
}

async function readBodyLimitedResponse(res: Response, maxBytes: number): Promise<string> {
  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes * 2) {
    return `[响应体过大: ${contentLength} bytes, 已跳过]`;
  }
  if (!res.body) return await res.text();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
      if (totalBytes >= maxBytes) break;
    }
  } finally {
    reader.releaseLock();
  }

  return chunks.join('');
}

export async function executeFetch(url: string): Promise<string> {
  try {
    new URL(url);
  } catch {
    return '无效的URL格式';
  }

  try {
    assertUrlSsrfSafe(url);
  } catch (err) {
    logger.warn({ url, err }, 'SSRF blocked');
    return '无法访问该地址';
  }

  const e = env();

  try {
    // Route 1: Worker proxy (preferred)
    if (e.FETCH_WORKER_URL) {
      let targetUrl = url;
      if (e.FETCH_GATEWAY_URL) {
        targetUrl = e.FETCH_GATEWAY_URL.replace('{URL}', encodeURIComponent(url));
      }

      const res = await fetch(e.FETCH_WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as { content?: string };
      if (json.content && typeof json.content === 'string') {
        const content = json.content.trim();
        if (!content) return formatOutput(url, '', '抓取成功，但未能提取有效内容。', false);
        const [summary, truncated] = truncateText(content);
        return formatOutput(url, '', summary, truncated);
      }
    }

    // Route 2: Gateway URL (e.g., Jina Reader) — fetch trusted gateway, validate redirect targets
    let targetUrl = url;
    if (e.FETCH_GATEWAY_URL) {
      targetUrl = e.FETCH_GATEWAY_URL.replace('{URL}', encodeURIComponent(url));
      const signal = AbortSignal.timeout(20_000);
      const fetched = await fetchWithRedirectGuard(targetUrl, {
        headers: { 'User-Agent': e.WEB_FETCH_USER_AGENT },
        signal,
      });
      if (!fetched.ok) return `抓取失败: 目标网页返回状态码 ${fetched.status}`;

      const contentType = fetched.headers.get('content-type') ?? '';
      return summarizePage(url, fetched.text, contentType);
    }

    // Route 3: Direct fetch — pinned TCP to resolved IP (mitigates DNS rebinding + validates no private hop)
    const pinned = await fetchUrlPinned(url, {
      headers: { 'User-Agent': e.WEB_FETCH_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
      maxBytes: MAX_FETCH_BYTES,
      timeoutMs: 20_000,
    });
    if (pinned.statusCode < 200 || pinned.statusCode >= 300) {
      return `抓取失败: 目标网页返回状态码 ${pinned.statusCode}`;
    }

    const contentType =
      typeof pinned.headers['content-type'] === 'string'
        ? pinned.headers['content-type']
        : Array.isArray(pinned.headers['content-type'])
          ? pinned.headers['content-type'][0] ?? ''
          : '';
    return summarizePage(url, pinned.body, contentType);
  } catch (err) {
    logger.error({ err, url }, 'Fetch failed');
    return `抓取失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function summarizePage(url: string, body: string, contentType: string): string {
  if (!body.trim()) return formatOutput(url, '', '抓取成功，但页面内容为空。', false);

  const isHtml =
    contentType.includes('text/html') ||
    body.includes('<html') ||
    body.includes('<!doctype html');

  if (!isHtml) {
    const [summary, truncated] = truncateText(body);
    return formatOutput(url, '', summary, truncated);
  }

  const titleMatch = body.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? '';
  const text = body
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const [summary, truncated] = truncateText(text);
  return formatOutput(url, title, summary, truncated);
}

function formatOutput(url: string, title: string, summary: string, truncated: boolean): string {
  return [
    '网页读取结果',
    `来源: ${url}`,
    `标题: ${title || 'N/A'}`,
    `状态: ${truncated ? '已截断' : '完整'}`,
    '',
    '摘要:',
    summary || 'N/A',
  ].join('\n');
}

function truncateText(text: string): [string, boolean] {
  if (text.length <= MAX_OUTPUT) return [text, false];
  return [text.slice(0, MAX_OUTPUT) + '\n\n[内容已截断]', true];
}
