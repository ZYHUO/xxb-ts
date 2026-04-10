// ────────────────────────────────────────
// Fallback chain + hedged request
// ────────────────────────────────────────

import type { AICallOptions, AICallResult, AILabel } from './types.js';
import { callModel } from './provider.js';
import { CooldownTracker } from './cooldown.js';
import { AIError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { getRedis } from '../db/redis.js';
import { loadOverride, resolveLabelForRuntime, resolveUsageForRuntime } from '../admin/runtime-config.js';
import { env } from '../env.js';

export async function callWithFallback(options: AICallOptions): Promise<AICallResult> {
  const override = await loadOverride(getRedis()).catch(() => null);
  const usage = resolveUsageForRuntime(options.usage, override);
  const labelNames = [usage.label, ...usage.backups];
  const cooldown = new CooldownTracker(getRedis());
  const hedgeDelayMs = env().HEDGE_DELAY_MS;

  const callOpts = {
    maxTokens: options.maxTokens ?? usage.maxTokens,
    temperature: options.temperature ?? usage.temperature,
    timeout: usage.timeout,
  };

  const errors: Error[] = [];
  let hedgeTriedLabel: string | undefined;

  for (let i = 0; i < labelNames.length; i++) {
    const labelName = labelNames[i]!;

    // Skip label already tried as a hedge
    if (labelName === hedgeTriedLabel) continue;

    const label = resolveLabelForRuntime(labelName, override);

    // Skip if cooling down
    if (await cooldown.isCoolingDown(label.model)) {
      logger.debug({ label: labelName, model: label.model }, 'Skipping cooled-down model');
      continue;
    }

    try {
      // Hedged request: if this is the primary and there's a backup,
      // race with a delayed backup call
      if (i === 0 && labelNames.length > 1 && hedgeDelayMs > 0) {
        hedgeTriedLabel = labelNames[1]!;
        const result = await hedgedCall(label, labelNames[1]!, options.messages, callOpts, hedgeDelayMs, cooldown, override);
        return result;
      }

      return await callModel(label, options.messages, callOpts);
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));

      // Set cooldown on 429
      if (err instanceof AIError && err.code === 'AI_RATE_LIMIT') {
        await cooldown.setCooldown(label.model);
      }

      logger.warn({ label: labelName, err: errors.at(-1)?.message }, 'Label failed, trying next');
    }
  }

  const lastErr = errors.at(-1);
  throw lastErr ?? new AIError('All labels exhausted', 'unknown', 'unknown', 'AI_ALL_FAILED');
}

async function hedgedCall(
  primaryLabel: AILabel,
  hedgeLabelName: string,
  messages: AICallOptions['messages'],
  callOpts: { maxTokens?: number; temperature?: number; timeout?: number },
  hedgeDelayMs: number,
  cooldown: CooldownTracker,
  override: Awaited<ReturnType<typeof loadOverride>>,
): Promise<AICallResult> {
  const hedgeLabel = resolveLabelForRuntime(hedgeLabelName, override);

  return new Promise<AICallResult>((resolve, reject) => {
    let settled = false;
    let primaryDone = false;
    let hedgeDone = false;
    let primaryError: Error | undefined;
    let hedgeError: Error | undefined;
    let hedgeStarted = false;

    const tryReject = () => {
      // Only reject when both primary and hedge have finished (or hedge never started)
      if (!settled && primaryDone && (hedgeDone || !hedgeStarted)) {
        settled = true;
        clearTimeout(hedgeTimer);
        reject(primaryError ?? hedgeError ?? new AIError('Hedged call failed', 'unknown', 'unknown', 'AI_HEDGE_FAILED'));
      }
    };

    callModel(primaryLabel, messages, callOpts)
      .then((result) => {
        if (!settled) {
          settled = true;
          clearTimeout(hedgeTimer);
          resolve(result);
        }
      })
      .catch((err: unknown) => {
        primaryDone = true;
        primaryError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof AIError && err.code === 'AI_RATE_LIMIT') {
          void cooldown.setCooldown(primaryLabel.model);
        }
        tryReject();
      });

    const hedgeTimer = setTimeout(() => {
      if (settled) return;

      void cooldown.isCoolingDown(hedgeLabel.model).then((cooling) => {
        if (settled || cooling) return;
        hedgeStarted = true;

        callModel(hedgeLabel, messages, callOpts)
          .then((result) => {
            if (!settled) {
              settled = true;
              resolve(result);
            }
          })
          .catch((err: unknown) => {
            hedgeError = err instanceof Error ? err : new Error(String(err));
            hedgeDone = true;
            tryReject();
          });
      });
    }, hedgeDelayMs);
  });
}
