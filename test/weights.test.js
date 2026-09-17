import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from '../src/server.js';
import reinforce from '../src/recipes/reinforce.js';
import { startServer, tempDir } from './helpers.js';

const ask = async (api, content, scenario = 'test') => {
  const r = await api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content }] }, { scenario });
  assert.equal(r.status, 200, r.text);
  return { receipt: r.headers.get('x-atoll-record-id'), text: r.json.choices[0].message.content, step: r.headers.get('x-atoll-step') };
};

test('a weights recipe without a runtime refuses to start', async (t) => {
  await assert.rejects(startServer(t, { recipe: 'imitate' }), /trains model weights — add --runtime/);
});

test('imitate: corrections train an adapter, evaluation publishes it, serving hot-swaps, rollback swaps back', async (t) => {
  const dir = tempDir();
  const state = join(dir, 'state');
  const { app, api } = await startServer(t, { runtime: 'mock', recipe: 'imitate', minBatch: 2, state });
  const q1 = await ask(api, 'What is the capital of Atlantis?');
  assert.equal(q1.text, 'mock reply to: What is the capital of Atlantis?');
  await api('POST', '/atoll/report', { score: 0, feedback: { correction: 'Poseidonia.' }, references: [q1.receipt] });
  assert.equal(app.engine.timers.size, 0, 'below --min-batch a report does not schedule training');

  const q2 = await ask(api, 'Who rules the sea?');
  await api('POST', '/atoll/report', { score: 1, references: [q2.receipt] });
  assert.equal(app.engine.timers.size, 1, 'reaching --min-batch schedules training');
  const noise = await ask(api, 'unrated');
  assert.ok(noise.receipt);

  const cand = (await api('POST', '/atoll/grow')).json;
  assert.equal(cand.surface, 'weights');
  assert.equal(cand.status, 'accepted', cand.decision?.reason);
  assert.equal(cand.step, 1);
  assert.equal(cand.train.examples, 2);
  assert.equal(cand.checks.eval.method, 'likelihood');
  assert.ok(cand.checks.eval.positives.candidate < cand.checks.eval.positives.current);
  assert.match(cand.checks.eval.reason, /good examples NLL 1\.100 → 0\.200/);

  // Hot swap: the same server now answers from the new adapter.
  const after = await ask(api, 'What is the capital of Atlantis?');
  assert.equal(after.text, 'Poseidonia.');
  assert.equal(after.step, '1');
  const rec = app.store.get('test').records.get(after.receipt);
  assert.match(rec.adapter, /^test@[0-9a-f]{16}$/);

  const weights = (await api('GET', '/atoll/weights')).json;
  assert.equal(weights.step, 1);
  assert.equal(weights.manifest.recipe, 'imitate');
  assert.equal(weights.manifest.examples, 2);
  assert.equal(weights.serving, rec.adapter);
  const download = await fetch(`${app.url}/atoll/weights/1/adapter`, { headers: { authorization: 'Bearer atoll-local', 'x-atoll-scenario': 'test' } });
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), weights.manifest.sha256);
  assert.equal(download.headers.get('x-atoll-adapter-sha256'), weights.manifest.sha256);
  const versions = (await api('GET', '/atoll/versions')).json.versions;
  assert.equal(versions[0].surface, 'weights');
  assert.equal(versions[0].weights.adapter.sha256, weights.manifest.sha256);

  // A restart with a fresh runtime reloads the published adapter from its blob.
  await app.close();
  const again = await startServer(t, { runtime: 'mock', recipe: 'imitate', minBatch: 2, state });
  assert.equal((await ask(again.api, 'What is the capital of Atlantis?')).text, 'Poseidonia.');

  const rb = (await again.api('POST', '/atoll/versions/0/rollback')).json;
  assert.equal(rb.step, 2);
  assert.equal((await ask(again.api, 'What is the capital of Atlantis?')).text, 'mock reply to: What is the capital of Atlantis?');
  assert.equal((await again.api('GET', '/atoll/weights')).json.serving, null);
  assert.deepEqual(again.app.runtime.loaded(), [], 'unused adapters are unloaded');
});

test('evaluation rejects an adapter that forgets general ability; the release keeps serving', async (t) => {
  const { app, api } = await startServer(t, { runtime: 'mock', recipe: 'imitate', minBatch: 1, train: { overfit: true } });
  const q = await ask(api, 'Say hi');
  await api('POST', '/atoll/report', { score: 0, feedback: { correction: 'HI!!!' }, references: [q.receipt] });
  const cand = (await api('POST', '/atoll/grow')).json;
  assert.equal(cand.status, 'rejected');
  assert.match(cand.decision.reason, /forgets too much/);
  assert.equal((await ask(api, 'What is 2+2?')).text, 'mock reply to: What is 2+2?');
  assert.equal((await ask(api, 'Say hi')).text, 'mock reply to: Say hi');
  assert.deepEqual(app.runtime.loaded(), []);
  assert.ok(existsSync(join(app.store.get('test').dir, 'retention.json')));
  // The trained blob is kept, so the rejection can still be overridden.
  const accepted = (await api('POST', `/atoll/candidates/${cand.id}/accept`, { reason: 'I want it anyway' })).json;
  assert.equal(accepted.step, 1);
  assert.equal((await ask(api, 'What is 2+2?')).text, 'HI!!!');
});

test('reinforce with an eval set: reward evaluation compares current and candidate answers', async (t) => {
  const dir = tempDir();
  const evalSet = join(dir, 'eval.jsonl');
  writeFileSync(evalSet, `${JSON.stringify({ prompt: 'What is 6 x 7? Reply with only the number.', expected: '42' })}\n${JSON.stringify({ prompt: 'Return exactly: ok', expected: 'ok' })}\n`);
  const { api } = await startServer(t, { runtime: 'mock', recipe: 'reinforce', minBatch: 1, evalSet });
  const q = await ask(api, 'What is 6 x 7? Reply with only the number.');
  await api('POST', '/atoll/report', { score: 0, feedback: { correction: '42' }, references: [q.receipt] });
  const cand = (await api('POST', '/atoll/grow')).json;
  assert.equal(cand.status, 'accepted', cand.decision?.reason);
  assert.equal(cand.checks.eval.method, 'reward');
  assert.equal(cand.checks.eval.current, 0.5);
  assert.equal(cand.checks.eval.candidate, 1);
  assert.equal((await ask(api, 'What is 6 x 7? Reply with only the number.')).text, '42');
});

test('reinforce advantages: per-prompt normalization, running baseline, corrections as positives', () => {
  const records = new Map();
  const reports = new Map();
  const add = (id, content, response, score, feedback = null) => {
    records.set(`rec_${id}`, { id: `rec_${id}`, status: 'ok', request: { system: '', messages: [{ role: 'user', content }] }, response: { text: response } });
    const r = { id: `rpt_${id}`, kind: 'report', score, feedback, references: [`rec_${id}`] };
    reports.set(r.id, r);
    return r;
  };
  const batch = [add('a', 'Q1', 'good', 1), add('b', 'Q1', 'bad', 0), add('c', 'Q2', 'meh', 1 / 3), add('d', 'Q3', 'wrong', 0, { correction: 'right' })];
  const scenario = { records, reports };
  const ex = reinforce.examples(batch, { scenario });
  const by = Object.fromEntries(ex.map((e) => [e.response, e.advantage]));
  assert.equal(by.good, 1);
  assert.equal(by.bad, -1);
  assert.equal(by.meh, undefined, 'at the running average: no signal, dropped');
  assert.equal(by.right, 1);
  assert.ok(by.wrong < 0);
});

test('manual selection holds a trained adapter as pending; accept publishes and swaps', async (t) => {
  const { app, api } = await startServer(t, { runtime: 'mock', recipe: 'imitate', minBatch: 1, selection: 'manual' });
  const q = await ask(api, 'Motto?');
  await api('POST', '/atoll/report', { score: 0, feedback: { correction: 'Grow slowly.' }, references: [q.receipt] });
  const cand = (await api('POST', '/atoll/grow')).json;
  assert.equal(cand.status, 'pending');
  assert.match(cand.decision.reason, /selection is manual — good examples/);
  assert.equal((await ask(api, 'Motto?')).text, 'mock reply to: Motto?', 'pending does not serve');
  assert.equal(app.runtime.loaded().length, 1, 'kept loaded for review');
  assert.equal((await api('POST', `/atoll/candidates/${cand.id}/accept`)).status, 200);
  assert.equal((await ask(api, 'Motto?')).text, 'Grow slowly.');
});

test('if the runtime cannot load the adapter, nothing is published', async (t) => {
  const { app, api } = await startServer(t, { runtime: 'mock', recipe: 'imitate', minBatch: 1 });
  const upload = app.runtime.upload;
  app.runtime.upload = async () => {
    throw new Error('disk full');
  };
  const q = await ask(api, 'Name?');
  await api('POST', '/atoll/report', { score: 0, feedback: { correction: 'atoll' }, references: [q.receipt] });
  const cand = (await api('POST', '/atoll/grow')).json;
  assert.equal(cand.status, 'failed');
  assert.match(cand.decision.reason, /disk full/);
  assert.equal((await app.store.get('test').artifact.head()).step, 0, 'no step without a loadable adapter');
  app.runtime.upload = upload;
  assert.equal((await ask(api, 'Name?')).text, 'mock reply to: Name?');
});

test('failed training leaves reports open and serving untouched; streaming works through a runtime', async (t) => {
  const { api } = await startServer(t, { runtime: 'mock', recipe: 'imitate', minBatch: 1, train: { fail: true } });
  const q = await ask(api, 'Ping');
  await api('POST', '/atoll/report', { score: 1, references: [q.receipt] });
  const cand = (await api('POST', '/atoll/grow')).json;
  assert.equal(cand.status, 'failed');
  assert.match(cand.decision.reason, /mock failure requested/);
  assert.equal((await api('GET', '/atoll/reports')).json.reports[0].state.status, 'open');
  const stream = await api('POST', '/v1/messages', { max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'Return exactly: live' }] });
  assert.match(stream.text, /"text":"live"/);
  const health = (await api('GET', '/healthz')).json;
  assert.equal(health.runtime.engine, 'mock');
  assert.equal(health.surface, 'weights');
});

test('remote runtime: the protocol client talks to any server that implements it', async (t) => {
  const { mockRuntime } = await import('../src/runtime/mock.js');
  const { createServer: http } = await import('node:http');
  const engine = mockRuntime();
  const jobs = new Map();
  const worker = http(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const json = () => JSON.parse(body.toString() || '{}');
    const send = (status, data) => {
      const out = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
      res.writeHead(status, { 'content-type': Buffer.isBuffer(data) ? 'application/octet-stream' : 'application/json' });
      res.end(out);
    };
    if (req.headers.authorization !== 'Bearer w0rk') return send(401, { error: 'bad token' });
    const url = req.url;
    try {
      if (url === '/v1/health') return send(200, { ...(await engine.health()), protocol: 1 });
      if (url === '/v1/generate') {
        const b = json();
        const r = await engine.generate({ adapter: b.adapter, system: b.system, messages: b.messages });
        return send(200, { text: r.text, adapter: r.adapter, finish_reason: 'stop', usage: r.usage });
      }
      if (url === '/v1/score') return send(200, { nll: await engine.score(json()) });
      if (url === '/v1/train') {
        const b = json();
        const job = await engine.train({ adapter: b.adapter, kind: b.kind, startFrom: b.start_from, examples: b.examples, hyper: b.hyper });
        jobs.set(job.id, job);
        return send(202, { ...job, status: 'running' });
      }
      const m = url.match(/^\/v1\/(train|adapters)\/([^/]+)(\/file)?$/);
      if (m?.[1] === 'train') return send(200, jobs.get(m[2]));
      if (m && req.method === 'GET') return send(200, await engine.download(decodeURIComponent(m[2])));
      if (m && req.method === 'PUT') return send(200, await engine.upload(decodeURIComponent(m[2]), body));
      if (m && req.method === 'DELETE') return send(200, { deleted: await engine.remove(decodeURIComponent(m[2])) });
      send(404, { error: 'no route' });
    } catch (e) {
      send(e.status ?? 500, { error: e.message });
    }
  });
  await new Promise((r) => worker.listen(0, '127.0.0.1', r));
  t.after(() => worker.close());
  const { app, api } = await startServer(t, { runtime: 'remote', runtimeUrl: `http://127.0.0.1:${worker.address().port}`, runtimeToken: 'w0rk', recipe: 'imitate', minBatch: 1 });
  app.runtime.pollMs = 10;
  assert.equal(app.runtime.model, 'mock-lm');
  const q = await ask(api, 'Remote?');
  await api('POST', '/atoll/report', { score: 0, feedback: { correction: 'Yes, remote.' }, references: [q.receipt] });
  const cand = (await api('POST', '/atoll/grow')).json;
  assert.equal(cand.status, 'accepted', cand.decision?.reason);
  assert.equal((await ask(api, 'Remote?')).text, 'Yes, remote.');
  await assert.rejects(createServer({ runtime: 'remote', runtimeUrl: `http://127.0.0.1:${worker.address().port}`, runtimeToken: 'nope', port: 0, state: join(tempDir(), 's'), log: () => {} }), /bad token/);
});

test('runtime mlx without an installed environment explains how to install it', async (t) => {
  await assert.rejects(startServer(t, { runtime: 'mlx', model: 'x', python: '/nonexistent/python', recipe: 'imitate' }), /atoll runtime install mlx/);
  assert.ok(readFileSync(new URL('../runtime/PROTOCOL.md', import.meta.url), 'utf8').includes('POST /v1/train'));
});
