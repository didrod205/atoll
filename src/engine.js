// Steps 3 and 4 — Grow and Commit, plus the governance actions on top of them.
//
//   new report ──triggers?──▶ schedule ──▶ select open reports ──▶ recipe.grow
//        ──▶ static checks ──▶ evaluator ──▶ judge ──▶ policy
//        ──accepted──▶ git commit + tag step-N ──▶ delivered on next pull
//        ──pending───▶ waits for accept / reject
//        ──rejected──▶ reason goes back to the recipe on the next attempt;
//                      the current release keeps serving

import { EventEmitter } from 'node:events';
import {
  applyChanges,
  candidateDiff,
  decide,
  isExecutable,
  judge,
  kindOf,
  normalizeFrontmatter,
  runEvaluator,
  staticCheck,
} from './evaluate.js';
import { reportStates } from './observe.js';
import { HttpError, newId, now, sha256, truncate } from './util.js';

export class Engine extends EventEmitter {
  constructor({ store, provider, recipe, cfg, log = () => {} }) {
    super();
    this.store = store;
    this.provider = provider;
    this.recipe = recipe;
    this.cfg = cfg;
    this.log = log;
    this.timers = new Map();
    this.running = new Set();
    this.rerun = new Set();
  }

  selection(s) {
    return s.meta.selection ?? this.cfg.selection;
  }

  states(s) {
    return reportStates(s, { maxAttempts: this.cfg.maxAttempts });
  }

  openReports(s) {
    const states = this.states(s);
    return [...s.reports.values()].filter((r) => states.get(r.id)?.status === 'open');
  }

  onReport(s, report) {
    this.emit('event', { type: 'report', scenario: s.name, id: report.id, kind: report.kind });
    if (this.recipe.triggers(report, this.openReports(s))) this.schedule(s);
  }

  schedule(s, delay = this.cfg.debounceMs) {
    if (this.running.has(s.name)) {
      this.rerun.add(s.name);
      return;
    }
    if (this.timers.has(s.name)) return;
    const timer = setTimeout(async () => {
      this.timers.delete(s.name);
      this.running.add(s.name);
      try {
        await this.grow(s);
      } catch (e) {
        this.log(`grow ${s.name}: ${e.message}`);
      } finally {
        this.running.delete(s.name);
      }
      if (this.rerun.delete(s.name)) this.schedule(s);
    }, delay);
    timer.unref?.();
    this.timers.set(s.name, timer);
  }

  /** Run one learning cycle now. Returns the candidate, or null when nothing is eligible. */
  grow(s) {
    return s.lock.run(async () => {
      const states = this.states(s);
      const open = [...s.reports.values()].filter((r) => states.get(r.id)?.status === 'open');
      const batch = this.recipe.select(open);
      if (!batch.length) return null;

      const { step } = await s.artifact.head();
      const files = await s.artifact.files();
      const cand = {
        id: newId('cand'),
        at: now(),
        status: 'running',
        recipe: this.recipe.name,
        baseStep: step,
        reports: batch.map((r) => r.id),
        summary: '',
        rationale: '',
        changes: [],
        addresses: [],
        skipped: [],
        checks: {},
      };
      s.job = cand.id;
      s.saveCandidate(cand);
      this.emit('event', { type: 'candidate', scenario: s.name, id: cand.id, status: cand.status });

      try {
        const records = new Map();
        const praise = [...s.reports.values()]
          .filter((r) => r.kind === 'report' && r.score != null && r.score >= 0.5 && r.feedback)
          .slice(-5);
        for (const r of [...batch, ...praise]) for (const ref of r.references) if (s.records.has(ref)) records.set(ref, s.records.get(ref));
        const rejections = new Map(batch.map((r) => [r.id, states.get(r.id).rejections]));
        const history = (await s.artifact.log()).filter((e) => e.step > 0).slice(0, 8);

        const draft = await this.recipe.grow({
          scenario: s.name,
          step,
          files,
          reports: batch,
          records,
          rejections,
          history,
          praise,
          complete: (c) => this.provider.complete(c, { model: this.cfg.growModel }),
        });

        const ids = new Set(batch.map((r) => r.id));
        cand.summary = String(draft.summary ?? 'update harness').slice(0, 120);
        cand.rationale = String(draft.rationale ?? '');
        cand.model = draft.model;
        cand.raw = truncate(draft.raw, 20_000);
        cand.changes = (draft.changes ?? []).map((c) => {
          const path = String(c?.path ?? '').replace(/^\.\//, '');
          if (c?.op === 'delete') return { op: 'delete', path };
          const markdown = /^(skills|commands)\/.*\.md$/.test(path);
          return { op: c?.op ?? 'write', path, content: markdown ? normalizeFrontmatter(c?.content) : c?.content };
        });
        cand.addresses = [...new Set((draft.addresses ?? []).filter((id) => ids.has(id)))];
        cand.skipped = (draft.skipped ?? []).filter((x) => ids.has(x.id) && !cand.addresses.includes(x.id));
        if (!cand.changes.length) {
          for (const id of ids) {
            if (!cand.addresses.includes(id) && !cand.skipped.some((x) => x.id === id)) cand.skipped.push({ id, why: 'recipe proposed no change for it' });
          }
          cand.addresses = [];
        }

        const stat = staticCheck(cand.changes, files);
        cand.checks.static = { ok: stat.ok, errors: stat.errors, warnings: stat.warnings, executable: stat.executable };
        cand.diff = candidateDiff(files, cand.changes);
        const selection = this.selection(s);
        if (stat.ok && cand.changes.length) {
          const after = applyChanges(files, cand.changes);
          if (this.cfg.evaluatorCmd) cand.checks.evaluator = await runEvaluator(this.cfg.evaluatorCmd, after);
          if (selection === 'judge' && (!cand.checks.evaluator || cand.checks.evaluator.ok) && cand.addresses.length) {
            try {
              cand.checks.judge = await judge(this.provider, {
                reports: batch.filter((r) => cand.addresses.includes(r.id)),
                earlier: [...s.reports.values()].filter((r) => states.get(r.id)?.status === 'addressed').slice(-20),
                records,
                summary: cand.summary,
                diff: cand.diff,
                after,
                model: this.cfg.judgeModel,
              });
            } catch (e) {
              cand.checks.judge = { error: e.message };
            }
          }
        }
        const d = decide({ checks: cand.checks, changes: cand.changes, selection, threshold: this.cfg.threshold, addresses: cand.addresses });
        cand.decision = { by: 'policy', reason: d.reason, at: now() };
        // Status flips only once the step exists, so "accepted" always means published.
        if (d.status === 'accepted') await this.#publish(s, cand);
        cand.status = d.status;
      } catch (e) {
        cand.status = 'failed';
        cand.decision = { by: 'system', reason: e.message, at: now() };
        this.log(`grow ${s.name}: ${e.message}`);
      } finally {
        s.job = null;
      }
      s.saveCandidate(cand);
      this.emit('event', { type: 'candidate', scenario: s.name, id: cand.id, status: cand.status, step: cand.step });
      return cand;
    });
  }

  async #publish(s, cand) {
    const head = await s.artifact.commit(cand.changes, {
      summary: cand.summary,
      body: cand.rationale,
      trailers: {
        'Atoll-Candidate': cand.id,
        'Atoll-Addresses': cand.addresses,
        'Atoll-Held': cand.checks.static?.executable ?? [],
        'Atoll-Score': cand.checks.judge?.score != null ? cand.checks.judge.score.toFixed(2) : null,
        'Atoll-Decided-By': cand.decision.by,
      },
    });
    cand.step = head.step;
    cand.commit = head.sha;
    this.emit('event', { type: 'version', scenario: s.name, step: head.step });
  }

  accept(s, id, reason) {
    return s.lock.run(async () => {
      const cand = s.candidates.get(id);
      if (!cand) throw new HttpError(404, `no candidate ${id}`);
      if (!['pending', 'rejected'].includes(cand.status)) throw new HttpError(409, `candidate is ${cand.status}; only pending or rejected candidates can be accepted`);
      if (!cand.changes.length) throw new HttpError(409, 'candidate has no changes');
      const { step } = await s.artifact.head();
      if (step !== cand.baseStep) {
        const moved = new Set(await s.artifact.changedSince(cand.baseStep));
        const conflicts = cand.changes.filter((c) => moved.has(c.path)).map((c) => c.path);
        if (conflicts.length) throw new HttpError(409, `the harness changed these paths since step ${cand.baseStep}; run grow again`, conflicts);
      }
      const stat = staticCheck(cand.changes, await s.artifact.files());
      if (!stat.ok) throw new HttpError(409, 'candidate no longer passes static checks', stat.errors);
      const previous = cand.decision;
      cand.decision = { by: 'user', reason: reason || 'accepted by user', at: now(), overrides: previous };
      try {
        await this.#publish(s, cand);
      } catch (e) {
        cand.decision = previous;
        throw e;
      }
      cand.status = 'accepted';
      s.saveCandidate(cand);
      this.emit('event', { type: 'candidate', scenario: s.name, id, status: cand.status, step: cand.step });
      return cand;
    });
  }

  reject(s, id, reason) {
    return s.lock.run(async () => {
      const cand = s.candidates.get(id);
      if (!cand) throw new HttpError(404, `no candidate ${id}`);
      if (cand.status !== 'pending') throw new HttpError(409, `candidate is ${cand.status}; only pending candidates can be rejected (roll back an accepted step instead)`);
      cand.status = 'rejected';
      cand.decision = { by: 'user', reason: reason || 'rejected by user', at: now() };
      s.saveCandidate(cand);
      this.emit('event', { type: 'candidate', scenario: s.name, id, status: cand.status });
      return cand;
    });
  }

  /** Allow the executable files introduced at a step to be delivered, pinned to their content at that step. */
  promote(s, step) {
    return s.lock.run(async () => {
      const tags = await s.artifact.stepTags();
      if (!tags.includes(step)) throw new HttpError(404, `no step ${step}`);
      const files = await s.artifact.files(step);
      const changed = new Set(await s.artifact.changedPaths(step));
      const targets = new Set([...changed].filter((p) => files.has(p) && isExecutable(p, files.get(p))));
      for (const p of [...targets]) {
        if (p.startsWith('hooks/') && p.endsWith('.json')) {
          try {
            const script = JSON.parse(files.get(p)).command;
            if (files.has(script)) targets.add(script);
          } catch {}
        }
      }
      if (!targets.size) throw new HttpError(409, `step ${step} introduced nothing that needs promotion`);
      const at = now();
      for (const p of targets) s.promotions[p] = { sha256: sha256(files.get(p)), step, at };
      s.savePromotions();
      this.emit('event', { type: 'promotion', scenario: s.name, step, paths: [...targets] });
      return { step, promoted: [...targets].sort() };
    });
  }

  /** Publish a new step whose tree equals an earlier one. History is never rewritten. */
  rollback(s, step) {
    return s.lock.run(async () => {
      const head = await s.artifact.head();
      const tags = await s.artifact.stepTags();
      if (!tags.includes(step)) throw new HttpError(404, `no step ${step}`);
      if (step === head.step) throw new HttpError(409, `step ${step} is already the current version`);
      const target = await s.artifact.files(step);
      const current = await s.artifact.files();
      const changes = [
        ...[...current.keys()].filter((p) => !target.has(p)).map((path) => ({ op: 'delete', path })),
        ...[...target].filter(([p, c]) => current.get(p) !== c).map(([path, content]) => ({ op: 'write', path, content })),
      ];
      const next = await s.artifact.commit(changes, {
        summary: `roll back to step ${step}`,
        body: changes.length ? '' : 'The tree already matched; recorded for the history.',
        trailers: { 'Atoll-Rollback-To': step, 'Atoll-Decided-By': 'user' },
      });
      this.emit('event', { type: 'version', scenario: s.name, step: next.step });
      return { step: next.step, restored: step, changes: changes.map(({ op, path }) => ({ op, path })) };
    });
  }

  async versions(s) {
    const log = await s.artifact.log();
    return log.map((e) => {
      const cand = s.candidates.get(e.trailers['Atoll-Candidate']);
      return {
        step: e.step,
        sha: e.sha,
        at: e.at,
        summary: e.summary,
        rationale: e.body,
        candidate: cand?.id ?? null,
        addresses: cand?.addresses ?? [],
        score: cand?.checks?.judge?.score ?? null,
        decidedBy: e.trailers['Atoll-Decided-By'] ?? null,
        rollbackTo: e.trailers['Atoll-Rollback-To'] != null ? Number(e.trailers['Atoll-Rollback-To']) : null,
        held: (e.trailers['Atoll-Held'] ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      };
    });
  }

  /** What an installed harness should contain right now. Unpromoted executable files are held back. */
  async bundle(s, step) {
    const head = await s.artifact.head();
    const files = await s.artifact.files(step ?? undefined);
    const entries = [...files]
      .filter(([p]) => kindOf(p))
      .map(([path, content]) => {
        const executable = isExecutable(path, content);
        const promoted = executable && s.promotions[path]?.sha256 === sha256(content);
        return { path, kind: kindOf(path), content, sha256: sha256(content), executable, held: executable && !promoted };
      });
    const byPath = new Map(entries.map((e) => [e.path, e]));
    for (const e of entries) {
      if (e.kind !== 'hook' || !e.path.endsWith('.json') || e.held) continue;
      try {
        const script = byPath.get(JSON.parse(e.content).command);
        if (!script || script.held) e.held = true;
      } catch {
        e.held = true;
      }
    }
    const delivered = entries.filter((e) => !e.held);
    const target = step ?? head.step;
    return {
      scenario: s.name,
      step: target,
      revision: sha256(`${target}\n${delivered.map((e) => `${e.path}:${e.sha256}`).sort().join('\n')}`).slice(0, 16),
      files: delivered,
      held: entries.filter((e) => e.held).map(({ path, kind }) => ({ path, kind })),
    };
  }

  async manifest(s) {
    const b = await this.bundle(s);
    const counts = { rule: 0, skill: 0, command: 0, hook: 0 };
    for (const f of b.files) {
      if (f.kind === 'skill' && !f.path.endsWith('/SKILL.md')) continue;
      if (f.kind === 'hook' && !f.path.endsWith('.json')) continue;
      counts[f.kind]++;
    }
    return { scenario: b.scenario, step: b.step, revision: b.revision, counts, held: b.held };
  }
}
