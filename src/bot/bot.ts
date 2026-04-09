import { Bot } from 'grammy';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { registerMessageHandler } from './handlers/message.js';

let _bot: Bot | undefined;
let _botUid = 0;

export async function createBot(): Promise<Bot> {
  if (!_bot) {
    _bot = new Bot(env().BOT_TOKEN);

    // Fetch bot identity for UID-based rule matching
    const me = await _bot.api.getMe();
    _botUid = me.id;
    logger.info({ botUid: _botUid, username: me.username }, 'Bot identity fetched');

    registerMessageHandler(_bot);

    _bot.catch((err) => {
      logger.error({ err: err.error }, 'Bot error');
    });
  }
  return _bot;
}

export function getBotUid(): number {
  return _botUid;
}

export function getBot(): Bot {
  if (!_bot) throw new Error('Bot not initialized. Call createBot() first.');
  return _bot;
}

export async function stopBot(): Promise<void> {
  if (_bot) {
    await _bot.stop();
    _bot = undefined;
  }
}
