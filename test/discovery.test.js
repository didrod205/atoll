import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { better, evaluateAttempt, loadProblem } from '../src/discovery.js';
import evolve from '../src/recipes/evolve.js';
import { startServer, tempDir } from './helpers.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/maximize', import.meta.url));

const until = async (fn, ms = 20_000) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('loadProblem validates the spec and reads the seed', () => {
  const p = loadProblem(FIXTURE);
  assert.equal(p.name, 'maximize-bump');
  assert.equal(p.seedCode.trim(), 'export const x = 1.0;');
  assert.equal(p.objective, 'maximize');
  const bad = tempDir();
  writeFileSync(join(bad, 'problem.json'), JSON.stringify({ name: 'bad name!', solution: { file: '../x' }, objective: 'up', sandbox: 'docker' }));
  assert.throws(
    () => loadProblem(bad),
    (e) => e.status === 422 && ['name:', 'task', 'solution.file', 'solution.language', 'evaluate', 'objective', 'sandbox'].every((k) => e.details.join('\n').includes(k)),
  );
  assert.ok(better({ objective: 'maximize' }, 2, 1) && !better({ objective: 'maximize' }, 1, 1) && better({ objective: 'minimize' }, 1, 2) && better({ objective: 'minimize' }, 5, null));
});

test('evaluateAttempt runs in a copy, parses the last JSON line, and enforces the timeout', async () => {
  const p = loadProblem(FIXTURE);
  const ok = await evaluateAttempt(p, 'export const x = 3.7;');
  assert.deepEqual([ok.valid, ok.score], [true, 10]);
  assert.equal(readFileSync(join(FIXTURE, 'seed.mjs'), 'utf8').trim(), 'export const x = 1.0;', 'the problem directory is never written');
  assert.ok(!existsSync(join(FIXTURE, 'solution.mjs')));
  const invalid = await evaluateAttempt(p, 'export const x = 99;');
  assert.equal(invalid.valid, false);
  assert.match(invalid.feedback, /must be a number in \[0, 10\]/);
  const crash = await evaluateAttempt(p, 'throw new Error("boom")');
  assert.match(crash.feedback, /solution failed: boom/);
  const slow = await evaluateAttempt({ ...p, timeoutSeconds: 1 }, 'while (true) {}\nexport const x = 1;');
  assert.equal(slow.valid, false);
  assert.match(slow.feedback, /timed out after 1s/);
  const silent = await evaluateAttempt({ ...p, evaluate: 'echo nothing useful; exit 3' }, 'x');
  assert.match(silent.feedback, /printed no JSON result \(exit 3\)/);
});

test('sandbox "macos" blocks network and writes outside the attempt', { skip: process.platform !== 'darwin' }, async () => {
  const p = { ...loadProblem(FIXTURE), sandbox: 'macos' };
  assert.equal((await evaluateAttempt(p, 'export const x = 3.7;')).score, 10);
  const net = await evaluateAttempt(p, "import http from 'node:http'; await new Promise((ok, no) => http.get('http://example.com', ok).on('error', no)); export const x = 1;");
  assert.equal(net.valid, false);
  const home = await evaluateAttempt(p, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.HOME + '/.atoll-sandbox-probe', 'x'); export const x = 1;");
  assert.match(home.feedback, /EPERM|operation not permitted/);
});

test('evolve prompt carries parents, feedback and failures; parse takes the last code block', () => {
  const p = loadProblem(FIXTURE);
  const parent = { id: 'cand_a', attempt: { score: 7.5, idea: 'try 2.1', feedback: 'x = 2.1', code: 'export const x = 2.1;' } };
  const failure = { attempt: { idea: 'go big', feedback: 'x must be a number in [0, 10], got 50' } };
  const { system, messages } = evolve.prompt({ problem: p, parents: [parent], failures: [failure], stats: { attempts: 4, best: 7.5 } });
  assert.match(system, /^ATOLL:EVOLVE/);
  const text = messages[0].content;
  assert.match(text, /<attempt id="cand_a" score="7.5">[\s\S]*```javascript\nexport const x = 2.1;\n```/);
  assert.match(text, /go big → x must be a number/);
  assert.match(text, /Attempts so far: 4\. Best score: 7.5 \(higher is better\)/);
  assert.deepEqual(evolve.parse('IDEA: closer\n```js\nold\n```\nactually:\n```javascript\nexport const x = 3;\n```'), { idea: 'closer', code: 'export const x = 3;\n' });
  assert.throws(() => evolve.parse('no code here'), /no fenced code block/);
});

test('a discovery run improves on the seed and publishes each new best as a step', async (t) => {
  const { app, api } = await startServer(t);
  const start = await api('POST', '/atoll/discovery', { problem: FIXTURE, attempts: 25 }, { scenario: 'bump' });
  assert.equal(start.status, 202, start.text);
  assert.equal((await api('POST', '/atoll/discovery', { problem: FIXTURE }, { scenario: 'bump' })).status, 409, 'one run per scenario');
  const view = await until(async () => {
    const v = (await api('GET', '/atoll/discovery', null, { scenario: 'bump' })).json;
    return v.status === 'done' && v;
  });
  const s = app.store.get('bump');
  const attempts = [...s.candidates.values()].filter((c) => c.surface === 'discovery');
  assert.equal(attempts.length, 26, 'seed + 25');
  const seed = attempts.find((c) => c.attempt.seed);
  assert.equal(seed.attempt.score, 10 - 2.7 ** 2);
  assert.ok(view.best.score > seed.attempt.score, `best ${view.best.score} should beat seed ${seed.attempt.score}`);
  const steps = (await api('GET', '/atoll/versions', null, { scenario: 'bump' })).json.versions;
  assert.ok(steps.length >= 3, 'seed plus at least one improvement');
  assert.ok(steps.every((v, i) => i === steps.length - 1 || v.surface === 'discovery'));
  const accepted = attempts.filter((c) => c.status === 'accepted').map((c) => c.attempt.score);
  assert.deepEqual(accepted, [...accepted].sort((a, b) => a - b), 'each published step beats the last');
  const files = await s.artifact.files();
  const best = JSON.parse(files.get('discovery/best.json'));
  assert.equal(best.score, view.best.score);
  assert.equal(files.get('discovery/solution.mjs'), attempts.find((c) => c.id === view.best.candidate).attempt.code);
  const withRecord = attempts.find((c) => !c.attempt.seed);
  const report = s.reports.get(withRecord.reports[0]);
  assert.equal(report.kind, 'eval');
  assert.equal(s.records.get(report.references[0]).source, 'discovery');
  const summary = (await api('GET', '/atoll/scenarios/bump')).json;
  assert.equal(summary.surface, 'discovery');
  assert.equal(summary.counts.open, 0, 'evaluator scores are not open feedback');
  assert.equal((await api('POST', '/atoll/grow', null, { scenario: 'bump' })).json.status, 'idle');
});

test('failures are recorded as attempts: no code, crashing code; stop ends a run', async (t) => {
  const replies = ['I think x should be 4.', 'IDEA: crash\n```javascript\nthrow new Error("nope")\n```', 'IDEA: good\n```javascript\nexport const x = 3.5;\n```'];
  let calls = 0;
  const provider = { name: 'scripted', native: null, model: 'scripted', complete: async () => ({ text: replies[calls++ % replies.length], model: 'scripted', usage: { input: 1, output: 1 } }) };
  const { app, api } = await startServer(t, { provider });
  await api('POST', '/atoll/discovery', { problem: FIXTURE, attempts: 3 });
  await until(async () => (await api('GET', '/atoll/discovery')).json.status === 'done');
  const attempts = [...app.store.get('test').candidates.values()].filter((c) => !c.attempt.seed);
  assert.deepEqual(attempts.map((c) => c.status), ['failed', 'failed', 'accepted']);
  assert.match(attempts[0].decision.reason, /no fenced code block/);
  assert.match(attempts[1].decision.reason, /solution failed: nope/);

  const slow = { ...provider, complete: async () => new Promise((r) => setTimeout(() => r({ text: replies[2], model: 's' }), 150)) };
  const second = await startServer(t, { provider: slow });
  await second.api('POST', '/atoll/discovery', { problem: FIXTURE, attempts: 50 });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await second.api('POST', '/atoll/discovery/stop')).status, 200);
  const stopped = await until(async () => {
    const v = (await second.api('GET', '/atoll/discovery')).json;
    return v.status === 'stopped' && v;
  });
  assert.ok(stopped.attempts.done < 50);
  assert.equal((await second.api('POST', '/atoll/discovery/stop')).status, 409);
  const missing = await second.api('POST', '/atoll/discovery', { problem: '/nope' });
  assert.equal(missing.status, 422);
});

test('test-time training: the proposer is fine-tuned on its scored attempts during the run', async (t) => {
  const dir = tempDir();
  const problem = join(dir, 'problem');
  cpSync(FIXTURE, problem, { recursive: true });
  const { app, api } = await startServer(t, { runtime: 'mock', state: join(dir, 'state') });
  await api('POST', '/atoll/discovery', { problem, attempts: 9, tuneEvery: 3 }, { scenario: 'ttt' });
  const view = await until(async () => {
    const v = (await api('GET', '/atoll/discovery', null, { scenario: 'ttt' })).json;
    return v.status === 'done' && v;
  });
  assert.equal(view.tuning.every, 3);
  assert.ok(view.tuning.runs >= 1, JSON.stringify(view.tuning));
  assert.ok(app.runtime.calls.train >= 1);
  const s = app.store.get('ttt');
  const log = readFileSync(join(s.dir, 'tune.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(existsSync(join(s.dir, 'blobs', `${log[0].sha256}.json`)));
  const late = [...s.records.values()].filter((r) => r.source === 'discovery').pop();
  assert.equal(late.adapter, view.tuning.last.adapter, 'later proposals come from the tuned adapter');
});

test('a tuned proposer that breaks the format is reverted to the previous one', async (t) => {
  const dir = tempDir();
  const { app, api } = await startServer(t, { runtime: 'mock', state: join(dir, 'state') });
  const generate = app.runtime.generate.bind(app.runtime);
  app.runtime.generate = async (args) => (args.adapter ? { text: 'I refuse to write code now.', adapter: args.adapter, finishReason: 'stop', usage: { input: 1, output: 1 } } : generate(args));
  await api('POST', '/atoll/discovery', { problem: FIXTURE, attempts: 9, tuneEvery: 3 }, { scenario: 'revert' });
  const view = await until(async () => {
    const v = (await api('GET', '/atoll/discovery', null, { scenario: 'revert' })).json;
    return v.status === 'done' && v;
  });
  const s = app.store.get('revert');
  const lines = readFileSync(join(s.dir, 'tune.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const verdict = lines.find((l) => l.status === 'reverted');
  assert.ok(verdict, JSON.stringify(lines));
  assert.match(verdict.reason, /valid 0% after tuning/);
  const attempts = [...s.candidates.values()].filter((c) => !c.attempt.seed).sort((a, b) => a.attempt.n - b.attempt.n);
  assert.ok(attempts.slice(3, 6).every((c) => c.status === 'failed'), 'the tuned proposer broke the format');
  const parseFailure = attempts[3];
  assert.equal(s.reports.get(parseFailure.reports[0]).feedback.valid, false, 'a format failure is still a scored attempt');
  assert.ok(attempts.slice(6).some((c) => c.attempt.valid), 'after the revert the previous proposer is back');
  assert.ok(view.tuning.runs >= 1);
});
