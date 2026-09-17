// evolve — repeated attempts at one problem. Each attempt shows the model the
// best solutions so far with their scores and evaluator feedback, asks for a
// better one, and runs the evaluator on it. With a trainable runtime the
// proposer is also fine-tuned on its own scored attempts as the run goes
// (test-time training).

import { truncate } from '../util.js';

const SYSTEM = `ATOLL:EVOLVE
You are improving a solution to one hard problem through repeated attempts. An automatic evaluator runs every attempt, checks that it is correct, and measures the objective. You see the best attempts so far with their scores and the evaluator's feedback, and some recent failures.

Propose one new attempt that is likely to beat the best score. Keep what works; change what the scores and feedback show is limiting. When small tweaks have stopped helping, try a different construction.

Reply in exactly this form and nothing else:
IDEA: <one line — what you changed and why>
\`\`\`<language>
<the complete contents of the solution file>
\`\`\`
The file must be complete and runnable on its own.`;

export default {
  name: 'evolve',
  surface: 'discovery',
  description: 'Propose → evaluate → keep the best, over many attempts; optionally fine-tunes the proposer on its scored attempts.',
  triggers: () => false,
  select: () => [],

  prompt({ problem, parents, failures, stats }) {
    const direction = problem.objective === 'minimize' ? 'lower is better' : 'higher is better';
    const parts = [
      `<problem name="${problem.name}" objective="${problem.objective}" note="${direction}">`,
      problem.task.trim(),
      `Solution file: ${problem.solution.file} (${problem.solution.language})`,
      '</problem>',
      '',
    ];
    for (const p of parents) {
      parts.push(`<attempt id="${p.id}" score="${p.attempt.score}">`);
      if (p.attempt.idea) parts.push(`<idea>${truncate(p.attempt.idea, 300)}</idea>`);
      if (p.attempt.feedback) parts.push(`<feedback>${truncate(p.attempt.feedback, 1200)}</feedback>`);
      parts.push(`\`\`\`${problem.solution.language}`, p.attempt.code.trimEnd(), '```', '</attempt>', '');
    }
    if (failures.length) {
      parts.push('<recent_failures>');
      for (const f of failures) parts.push(`- ${truncate(f.attempt.idea || 'no idea given', 160)} → ${truncate(f.attempt.feedback || f.decision?.reason || 'failed', 300)}`);
      parts.push('</recent_failures>', '');
    }
    parts.push(`Attempts so far: ${stats.attempts}. Best score: ${stats.best ?? 'none yet'} (${direction}).`);
    return { system: SYSTEM, messages: [{ role: 'user', content: parts.join('\n') }] };
  },

  parse(text) {
    const idea = (String(text).match(/^\s*IDEA:\s*(.+)$/m)?.[1] ?? '').trim();
    const blocks = [...String(text).matchAll(/```[\w+-]*[^\S\n]*\n([\s\S]*?)```/g)];
    if (!blocks.length) throw new Error('reply had no fenced code block');
    const code = blocks[blocks.length - 1][1];
    if (!code.trim()) throw new Error('code block was empty');
    return { idea: idea.slice(0, 300), code };
  },
};
