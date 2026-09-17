// The discovery surface: many attempts at one hard problem. Each attempt is a
// candidate — proposed by the model, run by the problem's own evaluator, and
// published as a new step whenever it beats the best score. With a trainable
// runtime the proposer is fine-tuned on its scored attempts as the run goes.
//
// problem.json
//   { "name": "circle-packing-26",
//     "task": "..." | "taskFile": "TASK.md",
//     "solution": { "file": "solution.mjs", "language": "javascript", "seed": "seed.mjs" },
//     "evaluate": "node evaluate.mjs solution.mjs",   // last stdout line: {"valid", "score", "feedback"}
//     "objective": "maximize" | "minimize",
//     "timeoutSeconds": 60, "budget": { "attempts": 40 }, "target": 2.63,
//     "sandbox": "none" | "macos" }

import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import evolve from './recipes/evolve.js';
import { HttpError, newId, now, sha256, truncate } from './util.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_CODE = 64_000;

const safeRelative = (p) => typeof p === 'string' && p && !isAbsolute(p) && !normalize(p).startsWith('..');

export function loadProblem(dir) {
  const root = resolve(dir);
  const file = join(root, 'problem.json');
  if (!existsSync(file)) throw new HttpError(422, `${file} not found`);
  let spec;
  try {
    spec = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new HttpError(422, `${file}: ${e.message}`);
  }
  const errors = [];
  if (!NAME.test(spec.name ?? '')) errors.push('name: 1-64 letters, digits, ".", "_" or "-"');
  let task = spec.task;
  if (spec.taskFile) {
    if (!safeRelative(spec.taskFile) || !existsSync(join(root, spec.taskFile))) errors.push(`taskFile ${spec.taskFile} not found`);
    else task = readFileSync(join(root, spec.taskFile), 'utf8');
  }
  if (typeof task !== 'string' || !task.trim()) errors.push('task (or taskFile) is required');
  const sol = spec.solution ?? {};
  if (!safeRelative(sol.file)) errors.push('solution.file must be a relative path inside the problem directory');
  if (typeof sol.language !== 'string') errors.push('solution.language is required (used for code fences)');
  let seedCode = null;
  if (sol.seed != null) {
    if (!safeRelative(sol.seed) || !existsSync(join(root, sol.seed))) errors.push(`solution.seed ${sol.seed} not found`);
    else seedCode = readFileSync(join(root, sol.seed), 'utf8');
  }
  if (typeof spec.evaluate !== 'string' || !spec.evaluate.trim()) errors.push('evaluate: the command that scores solution.file');
  const objective = spec.objective ?? 'maximize';
  if (!['maximize', 'minimize'].includes(objective)) errors.push('objective must be "maximize" or "minimize"');
  const timeoutSeconds = spec.timeoutSeconds ?? 60;
  if (!(timeoutSeconds > 0 && timeoutSeconds <= 3600)) errors.push('timeoutSeconds must be in (0, 3600]');
  const sandbox = spec.sandbox ?? 'none';
  if (!['none', 'macos'].includes(sandbox)) errors.push('sandbox must be "none" or "macos"');
  if (spec.target != null && !Number.isFinite(spec.target)) errors.push('target must be a number');
  if (errors.length) throw new HttpError(422, `invalid problem ${file}`, errors);
  return {
    name: spec.name,
    dir: root,
    task,
    solution: { file: sol.file, language: sol.language, seed: sol.seed ?? null },
    seedCode,
    evaluate: spec.evaluate,
    objective,
    timeoutSeconds,
    attempts: spec.budget?.attempts ?? 20,
    target: spec.target ?? null,
    sandbox,
  };
}

export const better = (problem, score, best) =>
  best == null || (problem.objective === 'minimize' ? score < best - 1e-12 : score > best + 1e-12);

function sandboxProfile(work) {
  const w = realpathSync(work).replace(/"/g, '\\"');
  return `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath "${w}") (subpath "/private/var/folders") (subpath "/private/tmp") (literal "/dev/null") (literal "/dev/dtracehelper"))`;
}

/** Copy the problem into a fresh directory, drop the code in, run the evaluator. */
export async function evaluateAttempt(problem, code) {
  const work = mkdtempSync(join(tmpdir(), 'atoll-attempt-'));
  try {
    cpSync(problem.dir, work, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules|\.atoll|\.atoll-runtime)$/.test(src) });
    if (existsSync(join(problem.dir, 'node_modules'))) symlinkSync(join(problem.dir, 'node_modules'), join(work, 'node_modules'));
    writeFileSync(join(work, problem.solution.file), code);
    const started = Date.now();
    const argv = problem.sandbox === 'macos' ? ['sandbox-exec', '-p', sandboxProfile(work), 'sh', '-c', problem.evaluate] : ['sh', '-c', problem.evaluate];
    const run = await new Promise((resolvePromise) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: work, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ATOLL_ATTEMPT_DIR: work } });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-64_000)));
      child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-8_000)));
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, problem.timeoutSeconds * 1000);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolvePromise({ code: null, stdout, stderr: e.message, timedOut });
      });
      child.on('close', (exit, signal) => {
        clearTimeout(timer);
        resolvePromise({ code: exit, signal, stdout, stderr, timedOut });
      });
    });
    const seconds = Number(((Date.now() - started) / 1000).toFixed(2));
    if (run.timedOut) return { valid: false, score: null, feedback: `timed out after ${problem.timeoutSeconds}s`, seconds };
    const line = run.stdout.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
    let result;
    try {
      result = JSON.parse(line);
    } catch {
      return { valid: false, score: null, feedback: truncate(`evaluator printed no JSON result (exit ${run.code ?? run.signal})${run.stderr.trim() ? `: ${run.stderr.trim()}` : ''}`, 2000), seconds };
    }
    const score = Number(result.score);
    const valid = result.valid === true && Number.isFinite(score);
    return { valid, score: valid ? score : null, feedback: truncate(String(result.feedback ?? (valid ? '' : 'invalid')), 2000), seconds };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Discovery {
  constructor(engine) {
    this.engine = engine;
    this.runs = new Map();
  }

  start(s, problem, options = {}) {
    const running = this.runs.get(s.name);
    if (running?.status === 'running') throw new HttpError(409, `a discovery run is already going in scenario "${s.name}"`);
    const run = new DiscoveryRun(this.engine, s, problem, options);
    this.runs.set(s.name, run);
    run.promise = run.loop();
    return run;
  }

  view(s) {
    return this.runs.get(s.name)?.view() ?? null;
  }

  stop(s) {
    const run = this.runs.get(s.name);
    if (!run || run.status !== 'running') throw new HttpError(409, `no discovery run is going in scenario "${s.name}"`);
    run.stopped = true;
    return run.view();
  }
}

class DiscoveryRun {
  constructor(engine, s, problem, { attempts, tuneEvery, tuneWindow, temperature } = {}) {
    this.engine = engine;
    this.s = s;
    this.problem = problem;
    this.total = attempts ?? problem.attempts;
    this.tuneEvery = engine.runtime?.trainable ? tuneEvery ?? 0 : 0;
    this.tuneWindow = tuneWindow ?? Math.max(8, (tuneEvery ?? 8) * 2);
    this.temperature = temperature ?? 0.8;
    this.done = 0;
    this.status = 'running';
    this.stopped = false;
    this.startedAt = now();
    this.adapter = undefined; // proposer adapter when tuning; undefined = provider default
    this.tunes = [];
    this.error = null;
  }

  attempts() {
    return [...this.s.candidates.values()].filter((c) => c.surface === 'discovery' && c.attempt?.problem === this.problem.name && c.status !== 'running');
  }

  best() {
    const valid = this.attempts().filter((c) => c.attempt.valid);
    const sign = this.problem.objective === 'minimize' ? 1 : -1;
    return valid.sort((a, b) => sign * (a.attempt.score - b.attempt.score))[0] ?? null;
  }

  view() {
    const best = this.best();
    return {
      scenario: this.s.name,
      problem: this.problem.name,
      objective: this.problem.objective,
      status: this.status,
      attempts: { done: this.done, total: this.total, all: this.attempts().length },
      best: best && { score: best.attempt.score, candidate: best.id, step: best.step ?? null, idea: best.attempt.idea },
      target: this.problem.target,
      tuning: this.tuneEvery ? { every: this.tuneEvery, runs: this.tunes.length, last: this.tunes[this.tunes.length - 1] ?? null } : null,
      startedAt: this.startedAt,
      error: this.error,
    };
  }

  emit(extra) {
    this.engine.emit('event', { type: 'discovery', scenario: this.s.name, ...extra });
  }

  async loop() {
    const { s, problem } = this;
    s.meta.surface = 'discovery';
    s.meta.problem = { name: problem.name, dir: problem.dir, objective: problem.objective };
    s.saveMeta();
    try {
      if (!this.attempts().length && problem.seedCode) await this.attempt({ seed: true });
      while (this.done < this.total && !this.stopped) {
        await this.attempt({});
        this.done++;
        const best = this.best();
        if (problem.target != null && best && !better(problem, problem.target, best.attempt.score)) {
          this.emit({ event: 'target', score: best.attempt.score });
          break;
        }
        // Tune only when another proposal will use the result.
        if (this.tuneEvery) await this.reviewTune();
        if (this.tuneEvery && this.done % this.tuneEvery === 0 && this.done < this.total && !this.stopped && this.tunes[this.tunes.length - 1]?.status !== 'trial' && this.done >= (this.nextTuneAt ?? 0)) await this.tune();
      }
      this.status = this.stopped ? 'stopped' : 'done';
    } catch (e) {
      this.status = 'failed';
      this.error = e.message;
      this.engine.log(`discovery ${s.name}: ${e.stack ?? e.message}`);
    }
    this.emit({ event: 'finished', status: this.status });
    return this.view();
  }

  async attempt({ seed = false }) {
    const { s, problem, engine } = this;
    const previous = this.attempts();
    const best = this.best();
    const cand = {
      id: newId('cand'),
      at: now(),
      status: 'running',
      recipe: evolve.name,
      surface: 'discovery',
      baseStep: (await s.artifact.head()).step,
      reports: [],
      addresses: [],
      skipped: [],
      summary: seed ? 'seed solution' : `attempt ${previous.length}`,
      rationale: '',
      changes: [],
      checks: {},
      attempt: { n: previous.length, problem: problem.name, seed, parents: [], idea: '', code: '', valid: false, score: null, feedback: '', seconds: 0 },
    };
    s.saveCandidate(cand);
    this.emit({ event: 'attempt', id: cand.id, status: 'running' });
    try {
      let code;
      let idea;
      let recordId = null;
      if (seed) {
        code = problem.seedCode;
        idea = 'seed solution from the problem';
      } else {
        const random = rng(Number.parseInt(sha256(`${problem.name}:${previous.length}`).slice(0, 8), 16));
        const valid = previous.filter((c) => c.attempt.valid).sort((a, b) => (problem.objective === 'minimize' ? a.attempt.score - b.attempt.score : b.attempt.score - a.attempt.score));
        const parents = valid.length ? [valid[0]] : [];
        const pool = valid.slice(1, 6);
        if (pool.length) parents.push(pool[Math.floor(random() * pool.length)]);
        const failures = previous.filter((c) => !c.attempt.valid).slice(-3);
        const { system, messages } = evolve.prompt({ problem, parents, failures, stats: { attempts: previous.length, best: best?.attempt.score ?? null } });
        cand.attempt.parents = parents.map((p) => p.id);
        const res = await engine.provider.complete(
          { system, messages, maxTokens: engine.cfg.discoveryMaxTokens ?? 4096, temperature: this.temperature },
          engine.runtime ? { adapter: this.adapter ?? null } : {},
        );
        const record = s.addRecord({
          id: newId('rec'),
          at: now(),
          source: 'discovery',
          format: 'discovery',
          model: res.model ?? null,
          adapter: res.adapter ?? null,
          step: cand.baseStep,
          request: { system, messages },
          response: { text: truncate(res.text, 40_000) },
          usage: res.usage,
          status: 'ok',
        });
        recordId = record.id;
        try {
          ({ idea, code } = evolve.parse(res.text));
        } catch (e) {
          // A reply that breaks the format is a scored failure too — tuning must see it.
          cand.reports = [this.report(recordId, { valid: false, score: null, feedback: e.message }).id];
          throw e;
        }
      }
      if (code.length > MAX_CODE) throw new Error(`solution is ${code.length} chars (max ${MAX_CODE})`);
      cand.attempt.idea = idea;
      cand.attempt.code = code;
      cand.summary = idea || cand.summary;
      const result = await evaluateAttempt(problem, code);
      Object.assign(cand.attempt, result);
      if (recordId) cand.reports = [this.report(recordId, result).id];
      if (!result.valid) {
        cand.status = 'failed';
        cand.decision = { by: 'evaluator', reason: result.feedback || 'invalid', at: now() };
      } else if (better(problem, result.score, best?.attempt.score)) {
        cand.decision = { by: 'evaluator', reason: `score ${best ? best.attempt.score : 'none'} → ${result.score}`, at: now() };
        cand.changes = [
          { op: 'write', path: `discovery/${problem.solution.file}`, content: code },
          {
            op: 'write',
            path: 'discovery/best.json',
            content: `${JSON.stringify({ problem: problem.name, objective: problem.objective, score: result.score, previous: best?.attempt.score ?? null, attempt: cand.attempt.n, candidate: cand.id, idea, feedback: result.feedback }, null, 2)}\n`,
          },
        ];
        cand.summary = `${result.score}${idea ? ` — ${idea}` : ''}`.slice(0, 120);
        await s.lock.run(() => engine.publishCandidate(s, cand));
        cand.status = 'accepted';
      } else {
        cand.status = 'rejected';
        cand.decision = { by: 'evaluator', reason: `score ${result.score} does not beat ${best.attempt.score}`, at: now() };
      }
    } catch (e) {
      cand.status = 'failed';
      cand.decision = { by: 'system', reason: e.message, at: now() };
    }
    s.saveCandidate(cand);
    this.emit({ event: 'attempt', id: cand.id, status: cand.status, score: cand.attempt.score, step: cand.step ?? null });
    return cand;
  }

  report(recordId, result) {
    return this.s.addReport({
      id: newId('rpt'),
      at: now(),
      kind: 'eval',
      score: result.valid ? result.score : null,
      feedback: { valid: result.valid, feedback: result.feedback },
      references: [recordId],
      source: 'evaluator',
    });
  }

  validRate(attempts) {
    return attempts.length ? attempts.filter((c) => c.attempt.valid).length / attempts.length : null;
  }

  /**
   * Keep a tuned adapter only if the attempts it proposed held up: when their
   * validity fell below what the previous proposer managed and they found no
   * new best, go back to the previous adapter.
   */
  async reviewTune() {
    const last = this.tunes[this.tunes.length - 1];
    if (!last || last.status !== 'trial') return;
    const since = this.attempts().filter((c) => !c.attempt.seed && c.attempt.n >= last.attempts);
    if (since.length < this.tuneEvery) return;
    const after = this.validRate(since);
    const improved = since.some((c) => c.status === 'accepted');
    const { runtime } = this.engine;
    if (!improved && after < last.validBefore) {
      await runtime.remove(last.adapter).catch(() => {});
      this.adapter = last.previous ?? undefined;
      this.nextTuneAt = this.done + this.tuneEvery; // give the restored proposer a full round first
      last.status = 'reverted';
      last.reason = `valid ${Math.round(after * 100)}% after tuning vs ${Math.round(last.validBefore * 100)}% before, no new best`;
    } else {
      if (last.previous) await runtime.remove(last.previous).catch(() => {});
      last.status = 'kept';
      last.reason = improved ? 'found a new best' : `valid ${Math.round(after * 100)}% vs ${Math.round(last.validBefore * 100)}% before`;
    }
    appendFileSync(join(this.s.dir, 'tune.jsonl'), `${JSON.stringify({ at: now(), adapter: last.adapter, status: last.status, reason: last.reason })}\n`);
    this.emit({ event: `tune-${last.status}`, adapter: last.adapter, reason: last.reason });
  }

  /** Test-time training: a policy-gradient step on the proposer's own recent attempts. */
  async tune() {
    const { s, problem, engine } = this;
    const runtime = engine.runtime;
    const recent = this.attempts()
      .filter((c) => !c.attempt.seed && c.reports.length)
      .slice(-this.tuneWindow);
    const examples = [];
    const scores = recent.filter((c) => c.attempt.valid).map((c) => c.attempt.score);
    const m = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const sd = scores.length > 1 ? Math.sqrt(scores.reduce((a, b) => a + (b - m) ** 2, 0) / scores.length) : 0;
    const sign = problem.objective === 'minimize' ? -1 : 1;
    for (const c of recent) {
      const report = s.reports.get(c.reports[0]);
      const record = report && s.records.get(report.references[0]);
      if (!record?.response?.text) continue;
      let advantage = c.attempt.valid ? (sd > 0 ? (sign * (c.attempt.score - m)) / sd : 0) : -1;
      advantage = Math.max(-2, Math.min(2, advantage));
      if (Math.abs(advantage) < 0.05) continue;
      examples.push({ system: record.request.system, messages: record.request.messages, response: record.response.text, advantage: Number(advantage.toFixed(4)) });
    }
    if (examples.length < 2) {
      this.emit({ event: 'tune-skipped', reason: `only ${examples.length} informative attempt(s)` });
      return;
    }
    const name = `${s.name}.tune.${this.attempts().length}`;
    const started = Date.now();
    this.emit({ event: 'tune-start', examples: examples.length });
    try {
      // Conservative by default: few samples, long sequences, and a proposer that must keep its format.
      const hyper = { steps: 4, batch_size: 2, kl_beta: 0.2, ...(engine.cfg.train ?? {}), ...(engine.cfg.tuneTrain ?? {}) };
      const job = await runtime.train({ adapter: name, kind: 'pg', startFrom: this.adapter ?? null, examples, hyper });
      const bytes = await runtime.download(name);
      const digest = sha256(bytes);
      mkdirSync(join(s.dir, 'blobs'), { recursive: true });
      writeFileSync(join(s.dir, 'blobs', `${digest}.${runtime.adapterExt}`), bytes);
      const previous = this.adapter;
      const validBefore = this.validRate(recent) ?? 0;
      this.adapter = name;
      const entry = { at: now(), attempts: this.attempts().length, adapter: name, previous: previous ?? null, sha256: digest, examples: examples.length, loss: job.loss, steps: job.total, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), validBefore, status: 'trial' };
      this.tunes.push(entry);
      appendFileSync(join(s.dir, 'tune.jsonl'), `${JSON.stringify(entry)}\n`);
      this.emit({ event: 'tune', ...entry });
    } catch (e) {
      this.emit({ event: 'tune-failed', reason: e.message });
      engine.log(`discovery ${s.name}: tuning failed: ${e.message}`);
    }
  }
}
