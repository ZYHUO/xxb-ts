// ────────────────────────────────────────
// Telegram Update → FormattedMessage 转换
// ────────────────────────────────────────

import type { FormattedMessage } from '../shared/types.js';

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TgSticker {
  file_id: string;
  file_unique_id: string;
  emoji?: string;
  set_name?: string;
  is_animated?: boolean;
  is_video?: boolean;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  date: number;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  sticker?: TgSticker;
  photo?: TgPhotoSize[];
  reply_to_message?: TgMessage;
  forward_from?: TgUser;
  forward_sender_name?: string;
  forward_from_chat?: { id: number; title?: string; type: string };
  forward_date?: number;
}

function buildFullName(user: TgUser): string {
  return user.last_name ? `${user.first_name} ${user.last_name}` : user.first_name;
}

function extractReplyTo(replyMsg: TgMessage): FormattedMessage['replyTo'] {
  const from = replyMsg.from;
  const text = replyMsg.text ?? replyMsg.caption ?? '';
  return {
    messageId: replyMsg.message_id,
    uid: from?.id ?? 0,
    fullName: from ? buildFullName(from) : 'Unknown',
    textSnippet: text.slice(0, 80),
  };
}

function getForwardFrom(msg: TgMessage): string | undefined {
  if (msg.forward_from) {
    return buildFullName(msg.forward_from);
  }
  if (msg.forward_sender_name) {
    return msg.forward_sender_name;
  }
  if (msg.forward_from_chat?.title) {
    return msg.forward_from_chat.title;
  }
  return undefined;
}

function getLargestPhoto(photos: TgPhotoSize[]): string | undefined {
  if (photos.length === 0) return undefined;
  // Sort by size descending, pick largest
  const sorted = [...photos].sort((a, b) => (b.width * b.height) - (a.width * a.height));
  return sorted[0]?.file_id;
}

export function formatMessage(update: Record<string, unknown>): FormattedMessage | null {
  const msg = (update['message'] ?? update['edited_message']) as TgMessage | undefined;
  if (!msg) return null;

  const from = msg.from;
  if (!from) return null;

  const isForwarded = !!(msg.forward_from ?? msg.forward_sender_name ?? msg.forward_from_chat ?? msg.forward_date);

  const formatted: FormattedMessage = {
    role: 'user',
    uid: from.id,
    username: from.username ?? '',
    fullName: buildFullName(from),
    timestamp: msg.date,
    messageId: msg.message_id,
    textContent: msg.text ?? '',
    isForwarded,
    isBot: from.is_bot ?? false,
  };

  if (msg.caption) {
    formatted.captionContent = msg.caption;
  }

  if (msg.sticker) {
    formatted.sticker = {
      emoji: msg.sticker.emoji ?? '',
      fileId: msg.sticker.file_id,
      fileUniqueId: msg.sticker.file_unique_id,
      setName: msg.sticker.set_name,
      isAnimated: msg.sticker.is_animated,
      isVideo: msg.sticker.is_video,
    };
  }

  if (msg.reply_to_message) {
    formatted.replyTo = extractReplyTo(msg.reply_to_message);
  }

  if (isForwarded) {
    formatted.forwardFrom = getForwardFrom(msg);
  }

  if (msg.photo && msg.photo.length > 0) {
    formatted.imageFileId = getLargestPhoto(msg.photo);
  }

  return formatted;
}
