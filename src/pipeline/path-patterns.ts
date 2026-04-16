import type { FormattedMessage } from '../shared/types.js';

export type PathPattern =
  | 'realtime_info'
  | 'link_inspect'
  | 'market_quote'
  | 'followup_lookup';

const URL_OR_DOMAIN_RE = /https?:\/\/\S+|\b[a-z0-9-]+\.(com|net|org|io|cn|ru|wiki|dev|app|xyz|me|cc|co)\b/i;
const INSPECT_VERB_RE = /(看一下|看看这个|这个呢|查一下|搜一下|读一下|打开|网页|网站|链接|link|url|fetch|web fetch)/i;
const QUERY_VERB_RE = /(看一下|看看|查一下|搜一下|帮我查|帮我看|帮我搜|告诉我|说说|多少|几度|几点|怎么样|如何|有没有|有吗|值多少|多少刀|多少美元|多少港币)/i;
const QUESTION_RE = /[?？]/;
const REALTIME_TOPIC_RE = /(天气|气温|温度|降雨|预报|湿度|风力|空气质量|aqi|汇率|油价|新闻|热点|热搜|时间|日期|weather|forecast|temperature|news|rate|time)/i;
const MARKET_TOPIC_RE = /(股票|股价|行情|市值|盘前|盘后|price|stock|market|ticker|币价|币圈|币|btc|eth|nvda|msft|aapl|tsla|英伟达|微软|苹果|特斯拉|老黄|巨硬)/i;
const REALTIME_QUALIFIER_RE = /(最新|实时|现在|今天|明天|后天|当前|today|tomorrow|current|latest|now)/i;
const FOLLOWUP_RE = /(呢|那|这个|那个|还有|咋样|怎么样|如何|老黄|巨硬|英伟达|微软|苹果|特斯拉|巴黎|东京|莫斯科|新加坡)/i;

function isQueryLike(text: string): boolean {
  return QUERY_VERB_RE.test(text) || QUESTION_RE.test(text);
}

function looksLikeRealtimeInfoRequest(text: string): boolean {
  const hasRealtimeTopic = REALTIME_TOPIC_RE.test(text);
  if (!hasRealtimeTopic) return false;
  return isQueryLike(text) || REALTIME_QUALIFIER_RE.test(text);
}

function looksLikeMarketQuoteRequest(text: string): boolean {
  const hasMarketTopic = MARKET_TOPIC_RE.test(text);
  if (!hasMarketTopic) return false;
  return isQueryLike(text) || REALTIME_QUALIFIER_RE.test(text);
}

export function looksLikeExternalLookupRequest(text: string): boolean {
  if (URL_OR_DOMAIN_RE.test(text) && INSPECT_VERB_RE.test(text)) return true;
  if (looksLikeRealtimeInfoRequest(text)) return true;
  if (looksLikeMarketQuoteRequest(text)) return true;
  return false;
}

export function looksLikeFollowupLookupRequest(
  message: FormattedMessage,
  botUid: number,
): boolean {
  if (message.replyTo?.uid !== botUid) return false;

  const currentText = (message.textContent || message.captionContent || '').trim();
  const repliedSnippet = message.replyTo.textSnippet || '';
  if (!currentText || !repliedSnippet) return false;

  const shortFollowup = currentText.length <= 24;
  const followupCue = FOLLOWUP_RE.test(currentText);
  const repliedLooksLookup =
    looksLikeRealtimeInfoRequest(repliedSnippet) ||
    looksLikeMarketQuoteRequest(repliedSnippet) ||
    URL_OR_DOMAIN_RE.test(repliedSnippet) ||
    /(美元|欧元|港币|多云|阵雨|晴|阴|股票代码|股价|price|weather|forecast)/i.test(repliedSnippet);

  return repliedLooksLookup && (shortFollowup || followupCue);
}

export function detectPathPatterns(
  message: FormattedMessage,
  botUid: number,
): PathPattern[] {
  const text = (message.textContent || message.captionContent || '').trim();
  const patterns: PathPattern[] = [];

  if (looksLikeFollowupLookupRequest(message, botUid)) {
    patterns.push('followup_lookup');
  }

  if (URL_OR_DOMAIN_RE.test(text) && INSPECT_VERB_RE.test(text)) {
    patterns.push('link_inspect');
  }

  if (looksLikeRealtimeInfoRequest(text)) {
    patterns.push('realtime_info');
  }

  if (looksLikeMarketQuoteRequest(text)) {
    patterns.push('market_quote');
  }

  return [...new Set(patterns)];
}
