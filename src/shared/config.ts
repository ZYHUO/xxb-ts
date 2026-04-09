import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../env.js';
import { logger } from './logger.js';

export interface AppConfig {
  promptsDir: string;
  migrationsDir: string;
}

function loadPrompt(relativePath: string, promptsDir: string): string {
  const fullPath = resolve(promptsDir, relativePath);
  if (!existsSync(fullPath)) {
    logger.warn({ path: fullPath }, 'Prompt file not found');
    return '';
  }
  return readFileSync(fullPath, 'utf-8');
}

let _config: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!_config) {
    // trigger env validation
    env();
    _config = {
      promptsDir: resolve(process.cwd(), 'prompts'),
      migrationsDir: resolve(process.cwd(), 'migrations'),
    };
  }
  return _config;
}

export { loadPrompt };
