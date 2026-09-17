// imitate — fine-tune the model on what worked: responses that scored well, and
// corrections the user wrote as feedback ({"correction": "..."}).

import { correctionOf, trainablePairs } from '../weights.js';

export default {
  name: 'imitate',
  surface: 'weights',
  train: 'sft',
  description: 'Fine-tunes a LoRA adapter on well-scored responses and on corrections given as feedback.',

  select(open, { scenario, cfg }) {
    const good = cfg.goodScore ?? 0.5;
    return open
      .filter((r) => trainablePairs(r, scenario).length && (correctionOf(r) != null || (typeof r.score === 'number' && r.score >= good)))
      .slice(0, cfg.maxBatch ?? 64);
  },

  triggers(report, open, ctx) {
    return this.select(open, ctx).length >= (ctx.cfg.minBatch ?? 4);
  },

  examples(reports, { scenario }) {
    const out = [];
    for (const r of reports) {
      const correction = correctionOf(r);
      for (const { record, prompt } of trainablePairs(r, scenario)) {
        const response = correction ?? record.response?.text;
        if (!response) continue;
        out.push({ ...prompt, response, weight: correction != null ? 1 : Math.min(1, Math.max(0.5, r.score)), report: r.id });
      }
    }
    return out;
  },
};
