// ────────────────────────────────────────
// Web page fetch tool implementation
// Port of PHP ToolService::fetchUrl()
// ────────────────────────────────────────

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import { lookup } from 'dns/promises';

const MAX_OUTPUT = 3200;
const MAX_FETCH_BYTES = 512 * 1024; // 512KB max download

// Blocked private/internal IP ranges
const BLOCKED_RANGES = [
  /^127\./,                       // 127.0.0.0/8 loopback
  /^10\./,                        // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./,  // 172.16.0.0/12
  /^192\.168\./,                  // 192.168.0.0/16
  /^169\.254\./,                  // 169.254.0.0/16 link-local
  /^0\./,                         // 0.0.0.0/8
  /^224\./,                       // 224.0.0.0/4 multicast
  /^240\./,                       // 240.0.0.0/4 reserved (class E)
  /^::1$/,                        // IPv6 loopback
  /^fd[0-9a-f]{2}:/i,            // IPv6 ULA
  /^fe80:/i,                      // IPv6 link-local
  /^::ffff:/i,                    // IPv4-mapped IPv6
];

function isPrivateIp(ip: string): boolean {
  return BLOCKED_RANGES.some((r) => r.test(ip));
}

async function validateUrl(url: string): Promise<string | null> {
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // Block direct IP
  if (isPrivateIp(hostname)) return `Blocked private IP: ${hostname}`;

  // Block localhost variants
  if (hostname === 'localhost' || hostname === '[::1]') return 'Blocked: localhost';

  // DNS resolve to check actual IP — use {all: true} to check all returned addresses
  try {
    const addresses = await lookup(hostname, { all: true });
    for (const { address } of addresses) {
      if (isPrivateIp(address)) return `Blocked: ${hostname} resolves to private IP ${address}`;
    }
  } catch {
    // DNS failure — allow through (will fail on fetch anyway)
  }

  return null;
}

export async function executeFetch(url: string): Promise<string> {
  try {
    new URL(url);
  } catch {
    return '无效的URL格式';
  }

  // SSRF protection: block private/internal addresses
  const blocked = await validateUrl(url);
  if (blocked) {
    logger.warn({ url, reason: blocked }, 'SSRF blocked');
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

    // Route 2: Gateway URL (e.g., Jina Reader)
    let targetUrl = url;
    if (e.FETCH_GATEWAY_URL) {
      targetUrl = e.FETCH_GATEWAY_URL.replace('{URL}', encodeURIComponent(url));
    }

    // Route 3: Direct fetch
    const res = await fetch(targetUrl, {
      headers: { 'User-Agent': e.WEB_FETCH_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    if (!res.ok) return `抓取失败: 目标网页返回状态码 ${res.status}`;

    const contentType = res.headers.get('content-type') ?? '';
    const body = await readBodyLimited(res, MAX_FETCH_BYTES);
    return summarizePage(url, body, contentType);
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

async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes * 2) {
    // Skip reading huge responses entirely
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
