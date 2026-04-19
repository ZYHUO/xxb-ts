import { executeValidatedToolStep } from '../tools/registry.js';
import type { ExecutedToolStep, ToolPlan } from './types.js';

export async function executeToolPlan(
  plan: ToolPlan,
  ctx: { chatId: number; userId: number },
): Promise<ExecutedToolStep[]> {
  const executed: ExecutedToolStep[] = [];

  for (const step of plan.steps) {
    const output = await executeValidatedToolStep(
      step.tool,
      step.args,
      ctx.chatId,
      ctx.userId,
    );
    executed.push({
      ...step,
      output,
    });
  }

  return executed;
}

export function formatToolResultsForPrompt(steps: ExecutedToolStep[]): string {
  if (steps.length === 0) return '';

  const lines = steps.map((step, index) => {
    const rendered = typeof step.output === 'string'
      ? step.output
      : JSON.stringify(step.output, null, 2);
    return [
      `Step ${index + 1}`,
      `tool: ${step.tool}`,
      `purpose: ${step.purpose}`,
      `args: ${JSON.stringify(step.args)}`,
      `output:\n${rendered}`,
    ].join('\n');
  });

  return `[TOOL_RESULTS]\n${lines.join('\n\n')}`;
}
