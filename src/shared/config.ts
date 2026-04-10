import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { env } from '../env.js';
import { logger } from './logger.js';

export interface AppConfig {
  promptsDir: string;
  migrationsDir: string;
  knowledgeBaseDir: string;
  personaDir: string;
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
    const e = env();
    const cwd = process.cwd();
    const knowledgeBaseDir = resolve(cwd, e.KNOWLEDGE_BASE_DIR);
    const personaDir = e.PERSONA_DIR
      ? isAbsolute(e.PERSONA_DIR)
        ? e.PERSONA_DIR
        : resolve(cwd, e.PERSONA_DIR)
      : resolve(cwd, 'prompts/persona');
    _config = {
      promptsDir: resolve(cwd, 'prompts'),
      migrationsDir: resolve(cwd, 'migrations'),
      knowledgeBaseDir,
      personaDir,
    };
  }
  return _config;
}

export { loadPrompt };

/** @internal test helper — clears cached AppConfig */
export function _resetAppConfig(): void {
  _config = undefined;
}
