import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;
const mockCallWithFallback = vi.fn();

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => testDb,
}));

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: Parameters<typeof mockCallWithFallback>) =>
    mockCallWithFallback(...args),
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({}),
}));

const {
  recordUserMessage,
  getUserProfilePrompt,
  runUserProfileSync,
} = await import('../../../src/tracking/user-profile.js');

function initSchema(db: Database.Database): void {
  const migrationSql = readFileSync(
    resolve(process.cwd(), 'migrations/0005_user_profiles.sql'),
    'utf-8',
  );
  db.exec(migrationSql);
}

describe('user-profile', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
    mockCallWithFallback.mockReset();
  });

  afterEach(() => {
    testDb.close();
  });

  it('appends pending_messages as a valid JSON array across multiple writes', () => {
    recordUserMessage(-1001, 42, 'alice', 'Alice', undefined, 'first');
    recordUserMessage(-1001, 42, 'alice', 'Alice', undefined, 'second');

    const row = testDb
      .prepare('SELECT pending_messages FROM user_profiles WHERE chat_id = ? AND uid = ?')
      .get(-1001, 42) as { pending_messages: string };

    expect(JSON.parse(row.pending_messages)).toEqual(['first', 'second']);
  });

  it('updates profile_prompt and clears pending_messages after successful sync', async () => {
    recordUserMessage(-1001, 42, 'alice', 'Alice', 'curious', 'first');
    recordUserMessage(-1001, 42, 'alice', 'Alice', 'curious', 'second');
    mockCallWithFallback.mockResolvedValue({ content: '喜欢提问，表达直接。' });

    await runUserProfileSync();

    expect(getUserProfilePrompt(-1001, 42)).toBe('喜欢提问，表达直接。');
    const row = testDb
      .prepare('SELECT pending_messages FROM user_profiles WHERE chat_id = ? AND uid = ?')
      .get(-1001, 42) as { pending_messages: string };
    expect(row.pending_messages).toBe('[]');
  });
});
