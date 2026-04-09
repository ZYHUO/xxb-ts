// ────────────────────────────────────────
// 图片描述 — Vision model
// ────────────────────────────────────────

import { getBot } from '../bot/bot.js';
import { callWithFallback } from '../ai/fallback.js';
import { loadPrompt, getConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';

/**
 * Describe an image via vision model.
 * Downloads from Telegram, sends to vision model, returns description.
 */
export async function describeImage(fileId: string): Promise<string> {
  try {
    // 1. Get file URL from Telegram
    const bot = getBot();
    const file = await bot.api.getFile(fileId);
    const filePath = file.file_path;

    if (!filePath) {
      logger.warn({ fileId }, 'No file_path returned from Telegram');
      return '[图片]';
    }

    // 2. Build download URL
    const token = bot.token;
    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

    // 3. Download image
    const response = await fetch(fileUrl);
    if (!response.ok) {
      logger.warn({ fileId, status: response.status }, 'Failed to download image from Telegram');
      return '[图片]';
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mimeType = response.headers.get('content-type') ?? 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64}`;

    // 4. Load vision prompt
    const config = getConfig();
    const visionPrompt = loadPrompt('task/vision.md', config.promptsDir);

    // 5. Call vision model
    const result = await callWithFallback({
      usage: 'vision',
      messages: [
        { role: 'system', content: visionPrompt },
        {
          role: 'user',
          content: [
            { type: 'image', image: dataUrl },
            { type: 'text', text: '请描述这张图片。' },
          ],
        },
      ],
      maxTokens: 200,
    });

    const description = result.content.trim();
    logger.debug({ fileId, descLength: description.length }, 'Image described');
    return description || '[图片]';
  } catch (err) {
    logger.warn({ fileId, err }, 'Vision failed, returning placeholder');
    return '[图片]';
  }
}
