// reinforce — a policy-gradient step on scored rollouts. Each response's
// advantage is its score against the other responses to the same prompt when
// there are several, otherwise against the scenario's running average; the
// runtime adds a KL penalty that keeps the adapter near the base model.

import { correctionOf, promptKey, trainablePairs } from '../weights.js';

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

export default {
  name: 'reinforce',
  surface: 'weights',
  train: 'pg',
  description: 'Policy-gradient updates from scored responses, normalized per prompt, with a KL penalty to the base model.',

  select(open, { scenario, cfg }) {
    return open
      .filter((r) => trainablePairs(r, scenario).length && (typeof r.score === 'number' || correctionOf(r) != null))
      .slice(0, cfg.maxBatch ?? 64);
  },

  triggers(report, open, ctx) {
    return this.select(open, ctx).length >= (ctx.cfg.minBatch ?? 4);
  },

  examples(reports, { scenario }) {
    const history = [...scenario.reports.values()].filter((r) => typeof r.score === 'number').map((r) => r.score);
    const baseline = history.length ? mean(history) : 0.5;
    const spread = std(history) || 0.5;
    const items = [];
    for (const r of reports) {
      const correction = correctionOf(r);
      for (const { record, prompt } of trainablePairs(r, scenario)) {
        const key = promptKey(prompt);
        if (typeof r.score === 'number' && record.response?.text) items.push({ key, score: r.score, ex: { ...prompt, response: record.response.text, report: r.id } });
        if (correction != null) items.push({ key, fixed: 1, ex: { ...prompt, response: correction, report: r.id } });
      }
    }
    const groups = new Map();
    for (const it of items) if (it.score != null) groups.set(it.key, [...(groups.get(it.key) ?? []), it.score]);
    const out = [];
    for (const it of items) {
      let advantage;
      if (it.fixed != null) advantage = it.fixed;
      else {
        const g = groups.get(it.key);
        advantage = g.length >= 2 && std(g) > 0 ? (it.score - mean(g)) / std(g) : (it.score - baseline) / spread;
      }
      advantage = Math.max(-2, Math.min(2, advantage));
      if (Math.abs(advantage) >= 0.05) out.push({ ...it.ex, advantage: Number(advantage.toFixed(4)) });
    }
    return out;
  },
};
