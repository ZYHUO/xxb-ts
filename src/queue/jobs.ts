// ────────────────────────────────────────
// Queue job 类型定义
// ────────────────────────────────────────

export const QUEUE_NAME = 'xxb:messages';

export interface MessageJobData {
  type: 'message' | 'allowlist_review';
  chatId: number;
  messageId?: number;
  update: Record<string, unknown>;
  enqueuedAt: number;
}
