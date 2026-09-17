// The weights surface: train a LoRA adapter from feedback, evaluate it against
// the adapter now serving, publish it as a version, and hot-swap serving to it.
//
//   version history  weights/adapter.json in the scenario's git artifact —
//                    a manifest pointing at a content-addressed blob
//   blobs            <scenario>/blobs/<sha256>.<ext>, outside git
//   serving          each scenario is served by the adapter of its head step

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, now, sha256, truncate, unifiedDiff } from './util.js';

export const WEIGHTS_MANIFEST = 'weights/adapter.json';

const RETENTION_PROMPTS = [
  'Explain what a hash table is in two sentences.',
  'Write a haiku about the ocean.',
  'What is the capital of France?',
  'Give three short tips for writing clear emails.',
  "Translate 'good morning' into Spanish.",
  'What does HTTP stand for?',
];

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (x) => (x == null ? 'n/a' : x.toFixed(3));

/** A correction the user supplied: feedback {"correction"|"ideal"|"expected": "..."}. */
export function correctionOf(report) {
  const f = report?.feedback;
  if (!f || typeof f !== 'object') return null;
  for (const k of ['correction', 'ideal', 'expected']) if (typeof f[k] === 'string' && f[k].trim()) return f[k];
  return null;
}

export function promptKey(prompt) {
  return sha256(JSON.stringify([prompt.system ?? '', prompt.messages])).slice(0, 16);
}

/** The prompt/response pairs a report points at, in trainable form. */
export function trainablePairs(report, scenario) {
  const out = [];
  for (const ref of report.references ?? []) {
    const record = scenario.records.get(ref);
    if (!record || record.status !== 'ok') continue;
    const messages = (record.request?.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
    if (!messages.length || messages[messages.length - 1].role !== 'user') continue;
    out.push({ record, prompt: { system: record.request.system || undefined, messages } });
  }
  return out;
}

export function loadEvalSet(file) {
  const tasks = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    let t;
    try {
      t = JSON.parse(line);
    } catch {
      throw new Error(`${file}:${i + 1}: not JSON`);
    }
    const messages = Array.isArray(t.messages) ? t.messages : typeof t.prompt === 'string' ? [{ role: 'user', content: t.prompt }] : null;
    if (!messages) throw new Error(`${file}:${i + 1}: needs "prompt" or "messages"`);
    tasks.push({ system: t.system, messages, expected: t.expected ?? null });
  }
  if (!tasks.length) throw new Error(`${file}: no tasks`);
  return tasks;
}

const normalize = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Run a verifier command: JSON on stdin, a number or {"score": n} as the last stdout line. */
export function runVerifier(cmd, payload, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const last = out.trim().split('\n').pop() ?? '';
      let score = Number(last);
      if (!Number.isFinite(score)) {
        try {
          score = Number(JSON.parse(last).score);
        } catch {}
      }
      if (!Number.isFinite(score)) return reject(new Error(`verifier exited ${code} without a score${err ? `: ${truncate(err.trim(), 300)}` : ''}`));
      resolve(score);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export class Weights {
  constructor(engine) {
    this.engine = engine;
    this.serving = new Map(); // scenario name -> adapter name | null
    this.loaded = new Set();
  }

  get runtime() {
    return this.engine.runtime;
  }

  blobPath(s, sha, ext) {
    return join(s.dir, 'blobs', `${sha}.${ext}`);
  }

  adapterName(s, sha) {
    return `${s.name}@${sha.slice(0, 16)}`;
  }

  async head(s) {
    const { step } = await s.artifact.head();
    const text = (await s.artifact.files()).get(WEIGHTS_MANIFEST);
    return { step, manifest: text ? JSON.parse(text) : null };
  }

  async ensureLoaded(s, manifest) {
    const name = this.adapterName(s, manifest.sha256);
    if (this.loaded.has(name)) return name;
    const file = this.blobPath(s, manifest.sha256, manifest.format ?? this.runtime.adapterExt);
    if (!existsSync(file)) throw new HttpError(500, `adapter blob ${manifest.sha256} is missing from ${s.dir}/blobs`);
    await this.runtime.upload(name, readFileSync(file));
    this.loaded.add(name);
    return name;
  }

  /** The adapter that serves a scenario right now (null = base model). */
  async adapterFor(s) {
    if (this.serving.has(s.name)) return this.serving.get(s.name);
    const { manifest } = await this.head(s);
    const name = manifest ? await this.ensureLoaded(s, manifest) : null;
    this.serving.set(s.name, name);
    return name;
  }

  invalidate(s) {
    this.serving.delete(s.name);
  }

  async unload(name) {
    if (!name || !this.loaded.has(name)) return;
    this.loaded.delete(name);
    await this.runtime.remove(name).catch(() => {});
  }

  /** Train a candidate adapter from a batch of reports and evaluate it. Fills cand; returns nothing. */
  async grow(s, cand, batch) {
    const runtime = this.runtime;
    const { cfg, recipe } = this.engine;
    if (!runtime?.trainable) throw new Error(`recipe "${recipe.name}" trains weights — start atoll with --runtime mlx, remote or mock`);
    const { manifest } = await this.head(s);
    const startFrom = manifest ? await this.ensureLoaded(s, manifest) : null;
    const examples = recipe.examples(batch, { scenario: s, cfg });
    const used = new Set(examples.map((e) => e.report));
    cand.addresses = batch.filter((r) => used.has(r.id)).map((r) => r.id);
    cand.skipped = batch.filter((r) => !used.has(r.id)).map((r) => ({ id: r.id, why: 'no usable prompt/response pair' }));
    if (!examples.length) {
      cand.summary = 'nothing to train on';
      return;
    }
    const name = `${s.name}.${cand.id}`;
    cand.summary = `${recipe.name}: ${examples.length} example(s) from ${cand.addresses.length} report(s)`;
    cand.train = { kind: recipe.train, examples: examples.length, from: manifest?.sha256 ?? null, progress: null };
    let lastEmit = 0;
    const job = await runtime.train(
      { adapter: name, kind: recipe.train, startFrom, examples: examples.map(({ report, ...ex }) => ex), hyper: cfg.train ?? {} },
      (j) => {
        cand.train.progress = { step: j.step, total: j.total, loss: j.loss };
        if (Date.now() - lastEmit > 1000) {
          lastEmit = Date.now();
          this.engine.emit('event', { type: 'training', scenario: s.name, id: cand.id, step: j.step, total: j.total, loss: j.loss });
        }
      },
    );
    this.loaded.add(name);
    cand.train = { ...cand.train, progress: null, steps: job.total, loss: job.loss, losses: (job.losses ?? []).slice(-100), seconds: job.seconds };

    const bytes = await runtime.download(name);
    const digest = sha256(bytes);
    mkdirSync(join(s.dir, 'blobs'), { recursive: true });
    const blob = this.blobPath(s, digest, runtime.adapterExt);
    if (!existsSync(blob)) writeFileSync(blob, bytes);
    cand.adapter = { name, sha256: digest, bytes: bytes.length, format: runtime.adapterExt };

    cand.checks.eval = await this.evaluate(s, { candidate: name, current: startFrom, examples });
    const next = {
      sha256: digest,
      bytes: bytes.length,
      format: runtime.adapterExt,
      engine: runtime.engine,
      model: runtime.model,
      lora: runtime.lora,
      recipe: recipe.name,
      trainedFrom: manifest?.sha256 ?? null,
      examples: examples.length,
      steps: job.total,
      loss: job.loss,
      eval: cand.checks.eval.error ? { error: cand.checks.eval.error } : { method: cand.checks.eval.method, summary: cand.checks.eval.reason },
      at: now(),
    };
    const content = `${JSON.stringify(next, null, 2)}\n`;
    cand.changes = [{ op: 'write', path: WEIGHTS_MANIFEST, content }];
    cand.diff = unifiedDiff(manifest ? `${JSON.stringify(manifest, null, 2)}\n` : null, content, { path: WEIGHTS_MANIFEST });
  }

  async evaluate(s, args) {
    try {
      const { cfg } = this.engine;
      return cfg.verifierCmd || cfg.evalSet ? await this.rewardEval(s, args) : await this.likelihoodEval(s, args);
    } catch (e) {
      return { error: e.message };
    }
  }

  /** Generate with both adapters on a task set and score the answers. */
  async rewardEval(s, { candidate, current }) {
    const { cfg } = this.engine;
    let tasks;
    let source;
    if (cfg.evalSet) {
      this.evalSet ??= loadEvalSet(cfg.evalSet);
      tasks = this.evalSet;
      source = cfg.evalSet;
    } else {
      tasks = this.recentPrompts(s, cfg.evalSize ?? 12);
      source = 'recent scored prompts';
    }
    if (!tasks.length) throw new Error('no evaluation tasks yet — pass --eval-set, or send scored traffic first');
    if (!cfg.verifierCmd && tasks.some((t) => t.expected == null)) throw new Error('eval tasks without "expected" need --verifier-cmd');
    const run = async (adapter) => {
      const scores = [];
      const answers = [];
      for (const t of tasks) {
        const r = await this.runtime.generate({ adapter, system: t.system, messages: t.messages, maxTokens: cfg.evalMaxTokens ?? 256, temperature: 0 });
        const score = cfg.verifierCmd
          ? await runVerifier(cfg.verifierCmd, { system: t.system ?? null, messages: t.messages, response: r.text, expected: t.expected })
          : normalize(r.text) === normalize(t.expected)
            ? 1
            : 0;
        scores.push(score);
        answers.push(r.text);
      }
      return { mean: mean(scores), scores, answers };
    };
    const cur = await run(current);
    const cand = await run(candidate);
    const gain = cand.mean - cur.mean;
    const minGain = cfg.minGain ?? 0;
    const ok = gain >= minGain;
    return {
      method: 'reward',
      source,
      tasks: tasks.length,
      current: cur.mean,
      candidate: cand.mean,
      gain,
      ok,
      reason: `${source}: mean score ${fmt(cur.mean)} → ${fmt(cand.mean)} over ${tasks.length} task(s)${ok ? '' : ` (needs a gain of at least ${minGain})`}`,
      samples: tasks.slice(0, 4).map((t, i) => ({
        prompt: truncate(t.messages[t.messages.length - 1].content, 200),
        current: truncate(cur.answers[i], 300),
        candidate: truncate(cand.answers[i], 300),
        scores: [cur.scores[i], cand.scores[i]],
      })),
    };
  }

  recentPrompts(s, limit) {
    const seen = new Set();
    const tasks = [];
    for (const r of [...s.reports.values()].reverse()) {
      if (typeof r.score !== 'number' && correctionOf(r) == null) continue;
      for (const { prompt } of trainablePairs(r, s)) {
        const key = promptKey(prompt);
        if (seen.has(key)) continue;
        seen.add(key);
        tasks.push({ ...prompt, expected: correctionOf(r) });
        if (tasks.length >= limit) return tasks;
      }
    }
    return tasks;
  }

  /**
   * Without a verifier: the candidate must make the good examples more likely
   * than the current adapter does, while its loss on the base model's own
   * answers to generic prompts stays within a tolerance of the base model's.
   */
  async likelihoodEval(s, { candidate, current, examples }) {
    const { cfg } = this.engine;
    const strip = ({ system, messages, response }) => ({ system, messages, response });
    const positives = examples.filter((e) => (e.advantage ?? e.weight ?? 1) > 0).map(strip);
    const negatives = examples.filter((e) => e.advantage != null && e.advantage < 0).map(strip);
    if (!positives.length) throw new Error('no positive examples to evaluate against');
    const retention = await this.retentionSet(s);
    const nll = async (adapter, exs) => (exs.length ? mean((await this.runtime.score({ adapter, examples: exs })).filter((n) => n != null)) : null);
    const pos = [await nll(current, positives), await nll(candidate, positives)];
    const neg = negatives.length ? [await nll(current, negatives), await nll(candidate, negatives)] : null;
    const ret = await nll(candidate, retention.items);
    const tolerance = cfg.retentionTolerance ?? 0.35;
    const improved = pos[1] < pos[0] - 1e-3;
    const kept = ret <= retention.baseNll + tolerance;
    const ok = improved && kept;
    const why = [
      `good examples NLL ${fmt(pos[0])} → ${fmt(pos[1])}${improved ? '' : ' (no improvement)'}`,
      neg ? `bad examples ${fmt(neg[0])} → ${fmt(neg[1])}` : null,
      `general ability NLL ${fmt(ret)} vs base ${fmt(retention.baseNll)} (+${tolerance} allowed)${kept ? '' : ' — forgets too much'}`,
    ].filter(Boolean);
    return {
      method: 'likelihood',
      ok,
      positives: { count: positives.length, current: pos[0], candidate: pos[1] },
      negatives: neg && { count: negatives.length, current: neg[0], candidate: neg[1] },
      retention: { count: retention.items.length, base: retention.baseNll, candidate: ret, tolerance },
      reason: why.join('; '),
    };
  }

  /** The base model's own answers to generic prompts, generated once per scenario and model. */
  async retentionSet(s) {
    const file = join(s.dir, 'retention.json');
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.model === this.runtime.model) return saved;
    }
    const items = [];
    for (const content of RETENTION_PROMPTS) {
      const messages = [{ role: 'user', content }];
      const r = await this.runtime.generate({ adapter: null, messages, maxTokens: 96, temperature: 0 });
      items.push({ messages, response: r.text });
    }
    const baseNll = mean((await this.runtime.score({ adapter: null, examples: items })).filter((n) => n != null));
    const saved = { model: this.runtime.model, at: now(), baseNll, items };
    writeFileSync(file, JSON.stringify(saved, null, 2));
    return saved;
  }
}
