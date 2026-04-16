// ────────────────────────────────────────
// Skill Loader — load external skill plugins from JSON files
// ────────────────────────────────────────

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from 'ai';
import type { Tool } from 'ai';
import { logger } from '../../shared/logger.js';

const execFileAsync = promisify(execFile);

// ── Schema ────────────────────────────────────────

const paramSchema = z.record(
  z.object({
    type: z.enum(['string', 'number', 'boolean']).default('string'),
    description: z.string().default(''),
  }),
);

const httpExecuteSchema = z.object({
  type: z.literal('http'),
  url: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
  headers: z.record(z.string()).optional(),
  body: z.record(z.unknown()).optional(),
  resultPath: z.string().optional(),
});

const scriptExecuteSchema = z.object({
  type: z.literal('script'),
  command: z.string(),
  args: z.array(z.string()).default([]),
  timeout: z.number().default(10000),
});

const skillSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: paramSchema.default({}),
  execute: z.discriminatedUnion('type', [httpExecuteSchema, scriptExecuteSchema]),
});

type SkillDef = z.infer<typeof skillSchema>;
type ParamDef = z.infer<typeof paramSchema>;

// ── Helpers ───────────────────────────────────────

function applyTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    params[key] !== undefined ? String(params[key]) : `{{${key}}}`,
  );
}

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function buildZodParams(params: ParamDef): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, def] of Object.entries(params)) {
    let field: z.ZodTypeAny;
    if (def.type === 'number') field = z.number();
    else if (def.type === 'boolean') field = z.boolean();
    else field = z.string();
    shape[key] = def.description ? field.describe(def.description) : field;
  }
  return z.object(shape);
}

// ── Executors ─────────────────────────────────────

async function executeHttp(
  exec: z.infer<typeof httpExecuteSchema>,
  params: Record<string, unknown>,
): Promise<unknown> {
  const url = applyTemplate(exec.url, params);
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname) || hostname === '::1') {
    throw new Error(`SSRF blocked: ${hostname}`);
  }
  const headers = exec.headers
    ? Object.fromEntries(Object.entries(exec.headers).map(([k, v]) => [k, applyTemplate(v, params)]))
    : {};

  const init: RequestInit = { method: exec.method, headers };
  if (exec.body && exec.method !== 'GET') {
    init.body = JSON.stringify(
      Object.fromEntries(
        Object.entries(exec.body).map(([k, v]) => [
          k,
          typeof v === 'string' ? applyTemplate(v, params) : v,
        ]),
      ),
    );
    (headers as Record<string, string>)['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const data: unknown = await res.json();
  return exec.resultPath ? getNestedValue(data, exec.resultPath) : data;
}

async function executeScript(
  exec: z.infer<typeof scriptExecuteSchema>,
  params: Record<string, unknown>,
): Promise<unknown> {
  const args = exec.args.map((a) => applyTemplate(a, params));
  const { stdout } = await execFileAsync(exec.command, args, { timeout: exec.timeout });
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return stdout.trim();
  }
}

// ── Skill → Tool ──────────────────────────────────

function skillToTool(skill: SkillDef): Tool {
  return tool({
    description: skill.description,
    parameters: buildZodParams(skill.parameters),
    execute: async (params: Record<string, unknown>) => {
      try {
        if (skill.execute.type === 'http') {
          return await executeHttp(skill.execute, params);
        } else {
          return await executeScript(skill.execute, params);
        }
      } catch (err) {
        logger.warn({ err, skill: skill.name }, 'Skill execution failed');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

// ── Public API ────────────────────────────────────

export async function loadSkills(skillsDir: string): Promise<Record<string, Tool>> {
  const tools: Record<string, Tool> = {};

  let files: string[];
  try {
    files = (await readdir(skillsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    // Directory doesn't exist or unreadable — silently skip
    return tools;
  }

  const BUILTIN_TOOLS = new Set(['SEARCH', 'FETCH', 'IP_QUALITY', 'ADD_TIMER', 'LIST_TIMERS', 'DELETE_TIMER', 'BOT_KNOWLEDGE']);

  for (const file of files) {
    const filePath = join(skillsDir, file);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const json: unknown = JSON.parse(raw);
      const skill = skillSchema.parse(json);
      if (!/^[A-Z0-9_]+$/.test(skill.name)) {
        logger.warn({ name: skill.name, file }, 'Skill name contains invalid characters (must match /^[A-Z0-9_]+$/), skipping');
        continue;
      }
      if (skill.execute.type === 'script') {
        logger.warn({ name: skill.name }, 'Skill type "script" is disabled for security reasons, skipping');
        continue;
      }
      if (BUILTIN_TOOLS.has(skill.name)) {
        logger.warn({ name: skill.name }, 'Skill name conflicts with a built-in tool, skipping');
        continue;
      }
      tools[skill.name] = skillToTool(skill);
      logger.debug({ name: skill.name, file }, 'Loaded skill');
    } catch (err) {
      logger.warn({ err, file: filePath }, 'Failed to load skill, skipping');
    }
  }

  return tools;
}
