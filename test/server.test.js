import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { scriptedRecipe, startServer, tempDir } from './helpers.js';

const until = async (fn, ms = 5000) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function serve(api, content = 'Return exactly: hi', scenario = 'test') {
  const r = await api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content }] }, { scenario });
  assert.equal(r.status, 200);
  return r.headers.get('x-atoll-record-id');
}

test('auth: inference and atoll routes need the token; healthz and the dashboard do not', async (t) => {
  const { app, api } = await startServer(t);
  assert.equal((await fetch(`${app.url}/healthz`)).status, 200);
  const page = await fetch(`${app.url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>atoll<\/title>/);
  const bad = await api('POST', '/v1/messages', { messages: [] }, { token: 'nope' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.type, 'error');
  assert.equal((await api('GET', '/atoll/scenarios', null, { token: 'nope' })).status, 401);
  // Anthropic SDKs send the key as x-api-key.
  const viaKey = await fetch(`${app.url}/atoll/scenarios`, { headers: { 'x-api-key': app.cfg.token } });
  assert.equal(viaKey.status, 200);
});

test('refuses a non-loopback bind with the default token', async (t) => {
  await assert.rejects(startServer(t, { host: '0.0.0.0' }), /default token/);
});

test('serve: OpenAI and Anthropic formats return receipts and are recorded', async (t) => {
  const { app, api } = await startServer(t);
  const openai = await api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'Return exactly: reef is ready' }] }, { scenario: 'new-one' });
  assert.equal(openai.json.choices[0].message.content, 'reef is ready');
  const receipt = openai.headers.get('x-atoll-record-id');
  assert.match(receipt, /^rec_/);
  assert.equal(openai.headers.get('x-atoll-harness-step'), '0');
  const s = app.store.get('new-one');
  assert.ok(s, 'an unknown scenario name creates the scenario');
  assert.equal(s.records.get(receipt).response.text, 'reef is ready');

  const anth = await api('POST', '/v1/messages', { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'Return exactly: ok' }] });
  assert.equal(anth.json.content[0].text, 'ok');
  assert.equal(anth.json.type, 'message');

  const stream = await api('POST', '/v1/messages', { max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'Return exactly: streamed' }] });
  assert.match(stream.headers.get('content-type'), /event-stream/);
  assert.match(stream.text, /event: content_block_delta[\s\S]*"text":"streamed"[\s\S]*event: message_stop/);
  // The receipt is usable the moment the response is read.
  const report = await api('POST', '/atoll/report', { score: 1, references: [stream.headers.get('x-atoll-record-id')] });
  assert.equal(report.status, 201);

  const malformed = await api('POST', '/v1/chat/completions', { messages: 'nope' });
  assert.equal(malformed.status, 400);
  assert.ok(malformed.json.error.message);
});

test('serve: passthrough to an OpenAI-compatible upstream keeps the raw body and captures streamed text', async (t) => {
  const seen = [];
  const upstream = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, json });
      if (json.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of ['Hel', 'lo']) res.write(`data: ${JSON.stringify({ model: json.model, choices: [{ delta: { content: piece } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: json.model, choices: [{ message: { content: 'plain' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 }, extra_field: true }));
      }
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const { app, api } = await startServer(t, { upstream: 'openai', upstreamUrl: `http://127.0.0.1:${upstream.address().port}/v1`, upstreamModel: 'gemma4:26b', upstreamApiKey: 'up-key' });

  const tools = [{ type: 'function', function: { name: 'f', parameters: {} } }];
  const plain = await api('POST', '/v1/chat/completions', { model: 'ignored', tools, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(plain.json.extra_field, true, 'upstream body passes through untouched');
  assert.deepEqual(seen[0].json.tools, tools);
  assert.equal(seen[0].json.model, 'gemma4:26b', 'the deployment model wins');
  assert.equal(seen[0].auth, 'Bearer up-key', 'the client token never reaches the upstream');

  const streamed = await api('POST', '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.match(streamed.text, /data: \[DONE\]/);
  const rec = app.store.get('test').records.get(streamed.headers.get('x-atoll-record-id'));
  assert.equal(rec.response.text, 'Hello');
  assert.equal(rec.status, 'ok');
});

test('observe: report validation matches receipts within the scenario', async (t) => {
  const { api } = await startServer(t);
  const receipt = await serve(api);
  const cases = [
    [{ references: [receipt] }, /score, feedback, or both/],
    [{ score: 1, references: [] }, /at least one receipt/],
    [{ score: 'high', references: [receipt] }, /finite number/],
    [{ feedback: ['x'], references: [receipt] }, /string or an object/],
  ];
  for (const [body, re] of cases) {
    const r = await api('POST', '/atoll/report', body);
    assert.equal(r.status, 422);
    assert.match(JSON.stringify(r.json.details), re);
  }
  const unknown = await api('POST', '/atoll/report', { score: 0, references: ['rec_nope'] });
  assert.equal(unknown.status, 422);
  assert.deepEqual(unknown.json.details, ['rec_nope']);
  await serve(api, 'x', 'other');
  const wrongScenario = await api('POST', '/atoll/report', { score: 0, references: [receipt] }, { scenario: 'other' });
  assert.equal(wrongScenario.status, 422, 'receipts do not cross scenarios');
  const ok = await api('POST', '/atoll/report', { score: 0.2, feedback: { issue: 'too long', want: 'one line' }, references: [receipt, receipt] });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.json.references, [receipt]);
});

test('grow → judge → commit: an ask becomes step 1 and ships in the bundle', async (t) => {
  const { app, api } = await startServer(t);
  const receipt = await serve(api);
  await api('POST', '/atoll/report', { score: 1, feedback: 'good job', references: [receipt] });
  const ask = await api('POST', '/atoll/harness/ask', { text: 'Use pnpm, never npm.' });
  assert.equal(ask.status, 201);

  const before = await api('GET', '/atoll/harness/manifest');
  const cand = (await api('POST', '/atoll/grow')).json;
  assert.equal(cand.status, 'accepted', cand.decision?.reason);
  assert.equal(cand.step, 1);
  assert.deepEqual(cand.addresses, [ask.json.id]);
  assert.ok(cand.checks.judge.score >= 0.7);

  const versions = (await api('GET', '/atoll/versions')).json.versions;
  assert.deepEqual(versions.map((v) => v.step), [1, 0]);
  assert.equal(versions[0].candidate, cand.id);
  const one = (await api('GET', '/atoll/versions/1')).json;
  assert.match(one.diff, /\+- Use pnpm, never npm\./);

  const bundle = (await api('GET', '/atoll/harness/bundle')).json;
  assert.deepEqual(bundle.files.map((f) => f.path), ['rules/use-pnpm-npm.md']);
  const after = (await api('GET', '/atoll/harness/manifest')).json;
  assert.notEqual(after.revision, before.json.revision);
  assert.deepEqual(after.counts, { rule: 1, skill: 0, command: 0, hook: 0 });

  const reports = (await api('GET', '/atoll/reports')).json.reports;
  assert.equal(reports.find((r) => r.id === ask.json.id).state.status, 'addressed');
  assert.equal((await api('POST', '/atoll/grow')).json.status, 'idle', 'praise alone does not grow');
  assert.equal(app.store.get('test').artifact.dir.endsWith('artifact'), true);
});

test('grow triggers on its own after an eligible report', async (t) => {
  const { app, api } = await startServer(t, { debounceMs: 20 });
  const receipt = await serve(api);
  await api('POST', '/atoll/report', { score: 1, references: [receipt] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.store.get('test').candidates.size, 0, 'a good score with no text does not trigger');
  await api('POST', '/atoll/report', { score: 0, feedback: 'Always answer in one sentence.', references: [receipt] });
  const s = app.store.get('test');
  await until(() => [...s.candidates.values()].some((c) => c.status === 'accepted'));
  assert.equal((await s.artifact.head()).step, 1);
});

test('rejection keeps the release serving, feeds the reason back, and goes stale after two attempts', async (t) => {
  const { app, api } = await startServer(t);
  const ask = (await api('POST', '/atoll/harness/ask', { text: 'Prefer tabs [mock:judge-fail]' })).json;
  const first = (await api('POST', '/atoll/grow')).json;
  assert.equal(first.status, 'rejected');
  assert.match(first.decision.reason, /does not address/);
  assert.equal((await app.store.get('test').artifact.head()).step, 0, 'nothing published');
  let state = (await api('GET', '/atoll/reports')).json.reports[0].state;
  assert.deepEqual([state.status, state.attempts], ['open', 1]);

  let prompt;
  const provider = app.provider;
  const original = provider.complete.bind(provider);
  provider.complete = async (c, o) => {
    if (c.system.includes('ATOLL:GROW')) prompt = c.messages[0].content;
    return original(c, o);
  };
  const second = (await api('POST', '/atoll/grow')).json;
  assert.equal(second.status, 'rejected');
  assert.match(prompt, new RegExp(`<previous_attempt candidate="${first.id}" rejected="judge: does not address ${ask.id}`));
  state = (await api('GET', '/atoll/reports')).json.reports[0].state;
  assert.equal(state.status, 'stale');
  assert.equal((await api('POST', '/atoll/grow')).json.status, 'idle');

  const bad = (await api('POST', '/atoll/harness/ask', { text: 'x [mock:bad-path]' })).json;
  const third = (await api('POST', '/atoll/grow')).json;
  assert.equal(third.status, 'rejected');
  assert.match(third.decision.reason, /static checks failed: .*escapes the harness/);
  assert.ok(bad.id);
});

test('manual selection: candidates wait; accept publishes, reject closes; accepting a judge rejection is allowed', async (t) => {
  const { app, api } = await startServer(t);
  await api('POST', '/atoll/scenarios', { name: 'test', selection: 'manual' });
  await api('POST', '/atoll/harness/ask', { text: 'Write commit messages in English.' });
  const pending = (await api('POST', '/atoll/grow')).json;
  assert.equal(pending.status, 'pending');
  assert.equal((await api('GET', '/atoll/scenarios/test')).json.counts.pending, 1);
  assert.equal((await api('POST', '/atoll/grow')).json.status, 'idle', 'pending reports are not re-grown');
  assert.deepEqual((await api('GET', '/atoll/versions')).json.pending, [pending.id]);

  const accepted = (await api('POST', `/atoll/candidates/${pending.id}/accept`, {})).json;
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.step, 1);
  assert.equal(accepted.decision.by, 'user');
  assert.equal((await api('POST', `/atoll/candidates/${pending.id}/accept`, {})).status, 409);

  await api('POST', '/atoll/harness/ask', { text: 'Never use emojis.' });
  const second = (await api('POST', '/atoll/grow')).json;
  const rejected = (await api('POST', `/atoll/candidates/${second.id}/reject`, { reason: 'too strict' })).json;
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.decision.reason, 'too strict');

  await api('POST', '/atoll/scenarios', { name: 'test', selection: 'judge' });
  await api('POST', '/atoll/harness/ask', { text: 'Use two-space indent [mock:judge-fail]' });
  const judged = (await api('POST', '/atoll/grow')).json;
  assert.equal(judged.status, 'rejected');
  const overridden = (await api('POST', `/atoll/candidates/${judged.id}/accept`, { reason: 'I know better' })).json;
  assert.equal(overridden.step, 2);
  assert.equal(overridden.decision.overrides.by, 'policy');
  assert.ok(app);
});

test('accept refuses a stale candidate whose paths moved underneath it', async (t) => {
  const { app, dir, api } = await startServer(t, { selection: 'manual' });
  await api('POST', '/atoll/harness/ask', { text: 'Use pnpm.' });
  const a = (await api('POST', '/atoll/grow')).json;
  await api('POST', '/atoll/harness/ask', { text: 'Use pnpm.' });
  const b = (await api('POST', '/atoll/grow')).json;
  assert.equal((await api('POST', `/atoll/candidates/${a.id}/accept`)).status, 200);
  const conflict = await api('POST', `/atoll/candidates/${b.id}/accept`);
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.json.details, ['rules/use-pnpm.md']);
  assert.ok(app && dir);
});

test('failed recipe call marks the candidate failed and leaves reports open', async (t) => {
  const { app, api } = await startServer(t);
  app.provider.complete = async () => {
    throw new Error('upstream down');
  };
  await api('POST', '/atoll/harness/ask', { text: 'Use pnpm.' });
  const c = (await api('POST', '/atoll/grow')).json;
  assert.equal(c.status, 'failed');
  assert.match(c.decision.reason, /upstream down/);
  assert.equal((await api('GET', '/atoll/reports')).json.reports[0].state.status, 'open');
});

test('executables are held until promoted; rollback publishes an older tree as a new step', async (t) => {
  const dir = tempDir();
  const { app, api } = await startServer(t, { recipe: scriptedRecipe(dir), selection: 'always' });
  const ask = async (text, draft) => {
    const r = (await api('POST', '/atoll/harness/ask', { text })).json;
    globalThis.__atollDraft = { summary: text, changes: draft, addresses: [r.id], skipped: [] };
    return (await api('POST', '/atoll/grow')).json;
  };
  const s1 = await ask('format after edits', [
    { op: 'write', path: 'hooks/format.json', content: JSON.stringify({ event: 'PostToolUse', matcher: 'Edit|Write', command: 'hooks/format.sh', timeout: 20 }) },
    { op: 'write', path: 'hooks/format.sh', content: '#!/bin/sh\nprettier --write . >/dev/null 2>&1 || true\n' },
    { op: 'write', path: 'rules/style.md', content: '- Keep functions short.\n' },
  ]);
  assert.equal(s1.step, 1);
  let bundle = (await api('GET', '/atoll/harness/bundle')).json;
  assert.deepEqual(bundle.files.map((f) => f.path), ['rules/style.md']);
  assert.deepEqual(bundle.held.map((f) => f.path).sort(), ['hooks/format.json', 'hooks/format.sh']);
  assert.deepEqual((await api('GET', '/atoll/versions')).json.versions[0].held.sort(), ['hooks/format.json', 'hooks/format.sh']);

  assert.equal((await api('POST', '/atoll/versions/9/promote')).status, 404);
  assert.equal((await api('POST', '/atoll/versions/0/promote')).status, 409, 'nothing to promote at step 0');
  const promoted = (await api('POST', '/atoll/versions/1/promote')).json;
  assert.deepEqual(promoted.promoted, ['hooks/format.json', 'hooks/format.sh']);
  bundle = (await api('GET', '/atoll/harness/bundle')).json;
  assert.equal(bundle.held.length, 0);

  // Changing the script later re-holds it (promotion is pinned to content).
  const s2 = await ask('quieter format', [{ op: 'write', path: 'hooks/format.sh', content: '#!/bin/sh\nprettier --log-level silent --write .\n' }]);
  bundle = (await api('GET', '/atoll/harness/bundle')).json;
  assert.deepEqual(bundle.held.map((f) => f.path).sort(), ['hooks/format.json', 'hooks/format.sh'], 'a held script holds its hook spec too');
  assert.equal(s2.step, 2);

  const rb = (await api('POST', '/atoll/versions/1/rollback')).json;
  assert.equal(rb.step, 3);
  assert.deepEqual(rb.changes, [{ op: 'write', path: 'hooks/format.sh' }]);
  bundle = (await api('GET', '/atoll/harness/bundle')).json;
  assert.equal(bundle.held.length, 0, 'rolled back to the promoted content');
  const v3 = (await api('GET', '/atoll/versions')).json.versions[0];
  assert.equal(v3.rollbackTo, 1);
  assert.equal((await api('POST', '/atoll/versions/3/rollback')).status, 409);
  assert.equal((await api('GET', '/atoll/harness/bundle?step=1')).json.step, 1);
  delete globalThis.__atollDraft;
  assert.ok(app);
});

test('records from hooks: receipts, session tracking and implicit corrections', async (t) => {
  const { app, api } = await startServer(t, { debounceMs: 20 });
  const post = (prompt, session = 's1') => api('POST', '/atoll/records', { prompt, response: 'done', session, tools: [{ name: 'Bash', input: 'npm i' }] });
  const first = (await post('install the deps')).json;
  assert.match(first.receipt, /^rec_/);
  assert.equal(first.implicit, null);
  const other = (await post('No, use pnpm', 's2')).json;
  assert.equal(other.implicit, null, 'a correction with no earlier turn in its session is not implicit feedback');
  const corrected = (await post('No, use pnpm')).json;
  assert.match(corrected.implicit, /^rpt_/);
  const s = app.store.get('test');
  assert.deepEqual(s.reports.get(corrected.implicit).references, [first.receipt]);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.candidates.size, 0, 'one implicit correction alone does not trigger');
  await post('again: pnpm, not npm');
  await until(() => s.candidates.size > 0 && ![...s.candidates.values()].some((c) => c.status === 'running'));
  const cand = [...s.candidates.values()][0];
  assert.equal(cand.reports.length, 2);
  assert.equal(cand.status, 'noop', 'the mock skips implicit corrections');
  assert.equal((await api('GET', '/atoll/reports')).json.reports[0].state.status, 'skipped');
});

test('state survives a restart', async (t) => {
  const dir = tempDir();
  const state = join(dir, 'state');
  const { app, api } = await startServer(t, { state });
  const receipt = await serve(api);
  await api('POST', '/atoll/harness/ask', { text: 'Use pnpm.' });
  await api('POST', '/atoll/grow');
  await app.close();
  const again = await startServer(t, { state });
  const s = again.app.store.get('test');
  assert.ok(s.records.has(receipt));
  assert.equal(s.reports.size, 1);
  assert.equal((await s.artifact.head()).step, 1);
  assert.equal((await again.api('GET', '/atoll/reports')).json.reports[0].state.status, 'addressed');
});

function sh(script, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', script], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err || out}`))));
    child.stdin.end(input ?? '');
  });
}

test('Claude Code harness: install, update, local edits, hooks, record, report, uninstall', async (t) => {
  const dir = tempDir();
  const { app, api } = await startServer(t, { recipe: scriptedRecipe(dir), selection: 'always' });
  const project = join(dir, 'my project'); // a space, on purpose
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'CLAUDE.md'), '# Mine\n\nKeep this.\n');
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));

  const publish = async (changes) => {
    const r = (await api('POST', '/atoll/harness/ask', { text: 'change' })).json;
    globalThis.__atollDraft = { summary: 'change', changes, addresses: [r.id] };
    const c = (await api('POST', '/atoll/grow')).json;
    assert.equal(c.status, 'accepted', c.decision?.reason);
    return c.step;
  };
  await publish([
    { op: 'write', path: 'rules/pnpm.md', content: '- Use pnpm.\n' },
    { op: 'write', path: 'skills/fix-bugs/SKILL.md', content: '---\nname: fix-bugs\ndescription: When fixing a bug\n---\nReproduce with a failing test first.\n' },
    { op: 'write', path: 'commands/ship.md', content: '---\ndescription: ship it\n---\nRun the release for $ARGUMENTS\n' },
  ]);

  const script = (await api('GET', '/atoll/harness/install?target=claude-code')).text;
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  const client = join(project, '.claude', 'atoll', 'client.mjs');
  const out = await sh('bash -s', project, script);
  assert.match(out, /harness step 1 installed/);
  const claudeMd = () => readFileSync(join(project, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd(), /^# Mine\n\nKeep this\.\n\n<!-- atoll:start -->[\s\S]*- Use pnpm\.\n<!-- atoll:end -->\n$/);
  assert.ok(existsSync(join(project, '.claude', 'skills', 'fix-bugs', 'SKILL.md')));
  assert.ok(existsSync(join(project, '.claude', 'commands', 'ship.md')));
  assert.match(readFileSync(join(project, '.claude', 'commands', 'atoll-harness.md'), 'utf8'), /allowed-tools: Bash\(node ".*my project\/\.claude\/atoll\/client\.mjs":\*\)/);
  const settings = () => JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings().permissions, { allow: ['Bash(ls)'] });
  assert.match(settings().hooks.SessionStart[0].hooks[0].command, /client\.mjs" session-start$/);
  assert.match(settings().hooks.Stop[0].hooks[0].command, /client\.mjs" record$/);

  const node = (args, input) => sh(`node "${client}" ${args}`, project, input);
  assert.equal(await node('session-start', '{}'), '', 'up to date: no notice');

  // New version: a notice, then the update removes, edits and keeps.
  writeFileSync(join(project, '.claude', 'commands', 'ship.md'), 'my own edit\n');
  await publish([
    { op: 'delete', path: 'skills/fix-bugs/SKILL.md' },
    { op: 'write', path: 'commands/ship.md', content: '---\ndescription: ship it v2\n---\nRelease $ARGUMENTS\n' },
    { op: 'write', path: 'rules/tests.md', content: '- Run tests before saying done.\n' },
    { op: 'write', path: 'hooks/lint.json', content: '{"event":"PostToolUse","matcher":"Edit","command":"hooks/lint.sh"}' },
    { op: 'write', path: 'hooks/lint.sh', content: 'echo lint\n' },
  ]);
  const notice = await node('session-start', '{}');
  assert.match(notice, /step 2 .*installed: step 1.*2 rule\(s\), 1 command\(s\).*\/atoll-update.*2 executable file\(s\) are held/s);
  const pulled = await node('pull');
  assert.match(pulled, /removed  \.claude\/skills\/fix-bugs\/SKILL\.md/);
  assert.match(pulled, /kept     \.claude\/commands\/ship\.md \(edited locally/);
  assert.match(pulled, /held     hooks\/lint\.json/);
  assert.equal(readFileSync(join(project, '.claude', 'commands', 'ship.md'), 'utf8'), 'my own edit\n');
  assert.ok(!existsSync(join(project, '.claude', 'skills')), 'empty skill directories are cleaned up');
  assert.match(claudeMd(), /- Use pnpm\.\n\n- Run tests before saying done\.\n<!-- atoll:end -->/);

  await api('POST', '/atoll/versions/2/promote');
  assert.match(await node('pull --force'), /added    \.claude\/atoll\/hooks\/lint\.sh/);
  assert.equal(readFileSync(join(project, '.claude', 'commands', 'ship.md'), 'utf8'), '---\ndescription: ship it v2\n---\nRelease $ARGUMENTS\n');
  const lintHook = settings().hooks.PostToolUse[0];
  assert.equal(lintHook.matcher, 'Edit');
  assert.equal(lintHook.hooks[0].command, 'bash "$CLAUDE_PROJECT_DIR/.claude/atoll/hooks/lint.sh"');

  // Record hook + /atoll-report through stdin like the slash commands do.
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, [JSON.stringify({ type: 'user', message: { content: 'add a login page' } }), JSON.stringify({ type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'Added.' }] } })].join('\n'));
  await node('record', JSON.stringify({ session_id: 'sess', transcript_path: transcript }));
  const state = JSON.parse(readFileSync(join(project, '.claude', 'atoll', 'state.json'), 'utf8'));
  const rec = app.store.get('test').records.get(state.lastReceipt);
  assert.equal(rec.request.messages[0].content, 'add a login page');
  assert.equal(rec.response.text, 'Added.');
  assert.match(await node('report', 'bad you forgot the "remember me" box\n'), /attached to the turn "add a login page" \(score 0\)/);
  const report = [...app.store.get('test').reports.values()].pop();
  assert.deepEqual([report.score, report.feedback, report.references], [0, 'you forgot the "remember me" box', [state.lastReceipt]]);
  assert.match(await node('ask', 'Prefer server components; don\'t use "use client" unless needed\n'), /filed rpt_/);
  assert.match(await node('versions'), /step 3 .*installed|step 2 .*installed/);
  assert.match(await node('versions', '2\n'), /\+- Run tests before saying done\./);

  // Atoll's own slash-command turns are not recorded as agent work.
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: '<command-name>/atoll-report</command-name>' } }));
  await node('record', JSON.stringify({ session_id: 'sess', transcript_path: transcript }));
  assert.equal(JSON.parse(readFileSync(join(project, '.claude', 'atoll', 'state.json'), 'utf8')).lastReceipt, state.lastReceipt);

  // Reinstall keeps the user's record choice.
  const cfgFile = join(project, '.claude', 'atoll', 'config.json');
  writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, 'utf8')), record: false }));
  await sh('bash -s', project, script);
  assert.equal(JSON.parse(readFileSync(cfgFile, 'utf8')).record, false);
  assert.equal(settings().hooks.Stop, undefined, 'record: false installs no Stop hook');
  assert.equal(settings().hooks.PostToolUse[0].hooks[0].command, 'bash "$CLAUDE_PROJECT_DIR/.claude/atoll/hooks/lint.sh"', 'reinstall keeps promoted harness hooks');

  // Server down: hooks stay silent and succeed.
  await app.close();
  assert.equal(await node('session-start', '{}'), '');
  assert.equal(await node('record', JSON.stringify({ transcript_path: transcript })), '');

  await node('uninstall');
  assert.equal(claudeMd(), '# Mine\n\nKeep this.\n');
  assert.deepEqual(settings(), { permissions: { allow: ['Bash(ls)'] } });
  assert.ok(!existsSync(join(project, '.claude', 'atoll')));
  assert.ok(!existsSync(join(project, '.claude', 'commands', 'atoll-harness.md')));
  assert.ok(!existsSync(join(project, '.claude', 'commands', 'ship.md')), 'force-updated, so it is atoll content again and goes');
  delete globalThis.__atollDraft;
});
