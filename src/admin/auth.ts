import { createHmac } from 'crypto';
import { logger } from '../shared/logger.js';

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/**
 * Validate Telegram WebApp initData using HMAC-SHA256.
 * Returns the authenticated TelegramUser or null if validation fails.
 */
export function validateInitData(initData: string, botToken: string): TelegramUser | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');
    const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = createHmac('sha256', secret).update(dataCheckString).digest('hex');

    if (computed !== hash) return null;

    // Check auth_date freshness (5 min window)
    const authDate = params.get('auth_date');
    if (authDate) {
      const age = Math.floor(Date.now() / 1000) - parseInt(authDate, 10);
      if (age > 300) return null;
    }

    // Parse user
    const userJson = params.get('user');
    if (!userJson) return null;
    return JSON.parse(userJson) as TelegramUser;
  } catch (err) {
    logger.warn({ err }, 'validateInitData failed');
    return null;
  }
}

export function isMaster(userId: number, masterUid: number): boolean {
  return userId === masterUid && masterUid > 0;
}
