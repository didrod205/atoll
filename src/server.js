// Step 1 — Serve, and the HTTP surface for every other step.

import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProblem } from './discovery.js';
import { Engine } from './engine.js';
import { ingestRecord, validateAsk, validateReport } from './observe.js';
import { createProvider } from './providers.js';
import { builtinRecipes, loadRecipe } from './recipes/index.js';
import { createRuntime, runtimeProvider } from './runtime/index.js';
import { Store } from './store.js';
import {
  fromFormat,
  parseAnthropicResponse,
  parseOpenAIResponse,
  streamCollector,
  toFormatResponse,
  toFormatStream,
} from './translate.js';
import { HttpError, newId, now, safeEqual, truncate, VERSION } from './util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SOURCE = readFileSync(join(ROOT, 'harness', 'claude-code', 'client.mjs'), 'utf8');
const DASHBOARD = readFileSync(join(ROOT, 'src', 'dashboard.html'), 'utf8');
const SELECTIONS = ['judge', 'manual', 'always'];

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8901,
  token: 'atoll-local',
  state: '.atoll',
  upstream: 'claude',
  upstreamUrl: null,
  upstreamModel: null,
  upstreamApiKey: null,
  growModel: null,
  judgeModel: null,
  recipe: 'refine',
  selection: 'judge',
  threshold: 0.7,
  maxAttempts: 2,
  evaluatorCmd: null,
  // weights surface
  runtime: null,
  runtimeUrl: null,
  runtimeToken: null,
  model: null,
  python: null,
  loraRank: 8,
  loraLayers: 16,
  maxSeq: 1024,
  train: null,
  minBatch: 4,
  maxBatch: 64,
  goodScore: 0.5,
  verifierCmd: null,
  evalSet: null,
  evalSize: 12,
  minGain: 0,
  retentionTolerance: 0.35,
  // discovery surface
  discoveryMaxTokens: 4096,
  debounceMs: 1500,
  defaultScenario: 'default',
  maxBodyBytes: 10 * 1024 * 1024,
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `body larger than ${limit} bytes`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const text = await readBody(req, limit);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return res.end();
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

function providerError(format, status, message) {
  return format === 'anthropic'
    ? { type: 'error', error: { type: status >= 500 ? 'api_error' : 'invalid_request_error', message } }
    : { error: { message, type: status >= 500 ? 'upstream_error' : 'invalid_request_error', code: status } };
}

export async function createServer(options = {}) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
  if (!SELECTIONS.includes(cfg.selection)) throw new Error(`selection must be one of ${SELECTIONS.join(', ')}`);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
  if (!loopback && cfg.token === DEFAULTS.token) throw new Error('refusing to listen beyond loopback with the default token — pass --token');
  const log = cfg.log ?? ((m) => console.error(`[atoll] ${m}`));
  const store = await new Store(cfg.state).open();
  const recipe = await loadRecipe(cfg.recipe);
  if (recipe.surface === 'weights' && !cfg.runtime && !cfg.runtimeInstance) {
    throw new Error(`recipe "${recipe.name}" trains model weights — add --runtime mlx --model <id> (or --runtime remote --runtime-url <url>)`);
  }
  const runtime = cfg.runtimeInstance ?? (cfg.runtime ? await createRuntime(cfg, log) : null);
  let engine;
  // With a runtime, the runtime is the model: each scenario is served by its current adapter.
  const provider = runtime ? runtimeProvider(runtime, (s) => engine.weights.adapterFor(s)) : cfg.provider ?? createProvider(cfg);
  engine = new Engine({ store, provider, runtime, recipe, cfg, log });
  const listeners = new Set();
  engine.on('event', (e) => {
    const line = `data: ${JSON.stringify({ ...e, at: now() })}\n\n`;
    for (const res of listeners) res.write(line);
  });

  const scenarioName = (req, url) => req.headers['x-atoll-scenario'] || url.searchParams.get('scenario') || cfg.defaultScenario;

  function authorized(req, url) {
    const h = req.headers.authorization;
    const candidates = [h?.startsWith('Bearer ') ? h.slice(7) : null, req.headers['x-api-key']];
    if (req.method === 'GET' && url.pathname === '/atoll/events') candidates.push(url.searchParams.get('token'));
    return candidates.some((t) => typeof t === 'string' && safeEqual(t, cfg.token));
  }

  async function inference(req, res, url, format) {
    const body = await readJson(req, cfg.maxBodyBytes);
    let canon;
    try {
      canon = fromFormat(format, body);
    } catch (e) {
      return send(res, e.status ?? 400, providerError(format, 400, e.message));
    }
    const s = await store.ensure(scenarioName(req, url));
    const { step } = await s.artifact.head();
    const model = runtime ? runtime.model : cfg.upstreamModel || body.model || provider.model;
    const id = newId('rec');
    const started = Date.now();
    const record = {
      id,
      at: now(),
      source: 'proxy',
      format,
      model,
      step,
      harnessStep: step,
      request: {
        system: truncate(canon.system, 20_000),
        messages: canon.messages.map((m) => ({ role: m.role, content: truncate(m.content, 20_000) })),
      },
      status: 'in_progress',
    };
    // Visible in memory before the first byte leaves, so a report can follow the response immediately.
    s.records.set(id, record);
    const headers = { 'x-atoll-record-id': id, 'x-atoll-scenario': s.name, 'x-atoll-step': String(step), 'x-atoll-harness-step': String(step), 'access-control-expose-headers': 'x-atoll-record-id' };
    const finish = (response, extra = {}) => {
      s.addRecord({ ...record, response: response ? { text: truncate(response.text, 20_000) } : null, usage: response?.usage, adapter: response?.adapter ?? undefined, latencyMs: Date.now() - started, status: 'ok', ...extra });
      engine.emit('event', { type: 'record', scenario: s.name, id });
    };
    const abort = new AbortController();
    res.on('close', () => !res.writableFinished && abort.abort());

    try {
      if (provider.native === format) {
        const up = await provider.forward({ ...body, model }, { signal: abort.signal });
        const type = up.headers.get('content-type') ?? 'application/json';
        if (!up.ok) {
          const text = await up.text();
          finish(null, { status: 'error', error: truncate(text, 2000) });
          res.writeHead(up.status, { 'content-type': type, ...headers });
          return res.end(text);
        }
        if (body.stream) {
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...headers });
          const collector = streamCollector(format);
          const decoder = new TextDecoder();
          const reader = up.body.getReader();
          const chunks = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            collector.push(decoder.decode(value, { stream: true }));
            chunks.push(value);
            // Hold back the terminal event until the record exists.
            if (chunks.length > 1) res.write(chunks.shift());
          }
          finish(collector.result());
          for (const c of chunks) res.write(c);
          return res.end();
        }
        const text = await up.text();
        let parsed = { text: '', usage: {} };
        try {
          parsed = format === 'anthropic' ? parseAnthropicResponse(JSON.parse(text)) : parseOpenAIResponse(JSON.parse(text));
        } catch {}
        finish(parsed);
        res.writeHead(200, { 'content-type': type, ...headers });
        return res.end(text);
      }

      const result = await provider.complete(canon, { model, signal: abort.signal, scenario: s });
      finish(result);
      if (canon.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
        return res.end(toFormatStream(format, result, model));
      }
      return send(res, 200, toFormatResponse(format, result, model), headers);
    } catch (e) {
      if (abort.signal.aborted) {
        finish(null, { status: 'aborted' });
        return res.end();
      }
      const status = e.status ?? 502;
      finish(null, { status: 'error', error: truncate(e.message, 2000) });
      return send(res, status, providerError(format, status, e.message), headers);
    }
  }

  async function scenarioSummary(s) {
    const states = engine.states(s);
    const counts = { records: s.records.size, reports: s.reports.size, open: 0, pending: 0, addressed: 0, skipped: 0, stale: 0, evaluated: 0, candidates: s.candidates.size };
    for (const st of states.values()) counts[st.status] = (counts[st.status] ?? 0) + 1;
    const head = await s.artifact.head();
    const surface = s.meta.surface ?? recipe.surface ?? 'harness';
    return {
      name: s.name,
      createdAt: s.meta.createdAt,
      selection: engine.selection(s),
      recipe: recipe.name,
      surface,
      step: head.step,
      sha: head.sha,
      counts,
      job: s.job,
      serving: runtime && surface === 'weights' ? engine.weights.serving.get(s.name) ?? null : undefined,
      discovery: engine.discovery.view(s) ?? (s.meta.problem ? { status: 'idle', problem: s.meta.problem.name, objective: s.meta.problem.objective } : undefined),
    };
  }

  const routes = [
    [
      'GET',
      /^\/healthz$/,
      async () => ({
        ok: true,
        version: VERSION,
        upstream: provider.name,
        model: provider.model,
        recipe: recipe.name,
        surface: recipe.surface ?? 'harness',
        selection: cfg.selection,
        runtime: runtime ? { name: runtime.name, engine: runtime.engine, model: runtime.model, lora: runtime.lora, alive: !runtime.dead } : null,
      }),
    ],
    ['GET', /^\/v1\/models$/, async () => ({ object: 'list', data: [{ id: provider.model ?? provider.name, object: 'model', owned_by: 'atoll' }] })],
    ['POST', /^\/v1\/chat\/completions$/, (ctx) => inference(ctx.req, ctx.res, ctx.url, 'openai')],
    ['POST', /^\/v1\/messages$/, (ctx) => inference(ctx.req, ctx.res, ctx.url, 'anthropic')],

    ['GET', /^\/atoll\/recipes$/, async () => ({ active: recipe.name, builtin: builtinRecipes })],
    ['GET', /^\/atoll\/scenarios$/, async () => ({ scenarios: await Promise.all([...store.scenarios.values()].map(scenarioSummary)) })],
    [
      'POST',
      /^\/atoll\/scenarios$/,
      async ({ body }) => {
        if (body.selection != null && !SELECTIONS.includes(body.selection)) throw new HttpError(422, `selection must be one of ${SELECTIONS.join(', ')}`);
        const { scenario, created } = await store.create(body.name, body.selection ? { selection: body.selection } : {});
        if (!created && body.selection && scenario.meta.selection !== body.selection) {
          scenario.meta.selection = body.selection;
          scenario.saveMeta();
        }
        return [created ? 201 : 200, await scenarioSummary(scenario)];
      },
    ],
    ['GET', /^\/atoll\/scenarios\/([^/]+)$/, async ({ params }) => scenarioSummary(store.require(decodeURIComponent(params[0])))],

    [
      'POST',
      /^\/atoll\/report$/,
      async ({ body, scenario }) => {
        const s = store.require(scenario);
        const report = validateReport(body, s);
        engine.onReport(s, report);
        return [201, report];
      },
    ],
    [
      'POST',
      /^\/atoll\/harness\/ask$/,
      async ({ body, scenario }) => {
        const s = await store.ensure(scenario);
        const report = validateAsk(body, s);
        engine.onReport(s, report);
        return [201, report];
      },
    ],
    [
      'POST',
      /^\/atoll\/records$/,
      async ({ body, scenario }) => {
        const s = await store.ensure(scenario);
        const { step } = await s.artifact.head();
        const { record, implicit } = ingestRecord(body, s, step);
        engine.emit('event', { type: 'record', scenario: s.name, id: record.id });
        if (implicit) engine.onReport(s, implicit);
        return [201, { receipt: record.id, implicit: implicit?.id ?? null }];
      },
    ],
    [
      'GET',
      /^\/atoll\/records$/,
      async ({ scenario, url }) => {
        const s = store.require(scenario);
        const limit = Math.min(500, Number(url.searchParams.get('limit')) || 50);
        const byRecord = new Map();
        for (const r of s.reports.values()) for (const ref of r.references) byRecord.set(ref, [...(byRecord.get(ref) ?? []), { id: r.id, kind: r.kind, score: r.score }]);
        const records = [...s.records.values()].reverse().slice(0, limit).map((r) => ({ ...r, reports: byRecord.get(r.id) ?? [] }));
        return { records, total: s.records.size };
      },
    ],
    [
      'GET',
      /^\/atoll\/reports$/,
      async ({ scenario }) => {
        const s = store.require(scenario);
        const states = engine.states(s);
        return { reports: [...s.reports.values()].reverse().map((r) => ({ ...r, state: states.get(r.id) })) };
      },
    ],

    [
      'GET',
      /^\/atoll\/candidates$/,
      async ({ scenario }) => {
        const s = store.require(scenario);
        return {
          candidates: [...s.candidates.values()].reverse().map(({ raw, diff, changes, ...c }) => ({
            ...c,
            changes: changes.map(({ op, path }) => ({ op, path })),
          })),
        };
      },
    ],
    [
      'GET',
      /^\/atoll\/candidates\/([^/]+)$/,
      async ({ scenario, params }) => {
        const c = store.require(scenario).candidates.get(params[0]);
        if (!c) throw new HttpError(404, `no candidate ${params[0]}`);
        return c;
      },
    ],
    ['POST', /^\/atoll\/candidates\/([^/]+)\/accept$/, async ({ scenario, params, body }) => engine.accept(store.require(scenario), params[0], body.reason)],
    ['POST', /^\/atoll\/candidates\/([^/]+)\/reject$/, async ({ scenario, params, body }) => engine.reject(store.require(scenario), params[0], body.reason)],
    [
      'POST',
      /^\/atoll\/grow$/,
      async ({ scenario }) => {
        const cand = await engine.grow(store.require(scenario));
        return cand ?? { status: 'idle', reason: 'no open feedback the recipe can use' };
      },
    ],

    [
      'GET',
      /^\/atoll\/versions$/,
      async ({ scenario }) => {
        const s = store.require(scenario);
        return {
          versions: await engine.versions(s),
          pending: [...s.candidates.values()].filter((c) => c.status === 'pending').map((c) => c.id),
        };
      },
    ],
    [
      'GET',
      /^\/atoll\/versions\/(\d+)$/,
      async ({ scenario, params }) => {
        const s = store.require(scenario);
        const step = Number(params[0]);
        const v = (await engine.versions(s)).find((x) => x.step === step);
        if (!v) throw new HttpError(404, `no step ${step}`);
        return { ...v, diff: await s.artifact.diff(step), files: [...(await s.artifact.files(step)).keys()] };
      },
    ],
    ['POST', /^\/atoll\/versions\/(\d+)\/promote$/, async ({ scenario, params }) => engine.promote(store.require(scenario), Number(params[0]))],
    ['POST', /^\/atoll\/versions\/(\d+)\/rollback$/, async ({ scenario, params }) => engine.rollback(store.require(scenario), Number(params[0]))],

    [
      'GET',
      /^\/atoll\/weights$/,
      async ({ scenario, url }) => {
        const s = store.require(scenario);
        const at = url.searchParams.get('step');
        if (at != null) {
          if (!(await s.artifact.stepTags()).includes(Number(at))) throw new HttpError(404, `no step ${at}`);
          const text = (await s.artifact.files(Number(at))).get('weights/adapter.json');
          return { step: Number(at), manifest: text ? JSON.parse(text) : null };
        }
        const { step, manifest } = await engine.weights.head(s);
        return { step, manifest, serving: runtime ? await engine.weights.adapterFor(s) : null, runtime: runtime ? { name: runtime.name, model: runtime.model, lora: runtime.lora } : null };
      },
    ],
    [
      'GET',
      /^\/atoll\/weights\/(\d+)\/adapter$/,
      async ({ scenario, params, res }) => {
        const s = store.require(scenario);
        const step = Number(params[0]);
        if (!(await s.artifact.stepTags()).includes(step)) throw new HttpError(404, `no step ${step}`);
        const text = (await s.artifact.files(step)).get('weights/adapter.json');
        if (!text) throw new HttpError(404, `step ${step} has no adapter`);
        const manifest = JSON.parse(text);
        const file = engine.weights.blobPath(s, manifest.sha256, manifest.format);
        if (!existsSync(file)) throw new HttpError(404, `adapter blob ${manifest.sha256} is missing`);
        const bytes = readFileSync(file);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': bytes.length,
          'content-disposition': `attachment; filename="${s.name}-step-${step}.${manifest.format}"`,
          'x-atoll-adapter-sha256': manifest.sha256,
        });
        res.end(bytes);
      },
    ],
    [
      'POST',
      /^\/atoll\/discovery$/,
      async ({ scenario, body }) => {
        if (typeof body.problem !== 'string') throw new HttpError(422, '"problem" must be the path of a directory with problem.json');
        const problem = loadProblem(body.problem);
        const s = await store.ensure(scenario);
        const run = engine.discovery.start(s, problem, { attempts: body.attempts, tuneEvery: body.tuneEvery, tuneWindow: body.tuneWindow, temperature: body.temperature });
        return [202, run.view()];
      },
    ],
    ['GET', /^\/atoll\/discovery$/, async ({ scenario }) => (await scenarioSummary(store.require(scenario))).discovery ?? { status: 'idle' }],
    ['POST', /^\/atoll\/discovery\/stop$/, async ({ scenario }) => engine.discovery.stop(store.require(scenario))],
    ['GET', /^\/atoll\/harness\/manifest$/, async ({ scenario }) => engine.manifest(await store.ensure(scenario))],
    [
      'GET',
      /^\/atoll\/harness\/bundle$/,
      async ({ scenario, url }) => {
        const s = await store.ensure(scenario);
        const step = url.searchParams.get('step');
        if (step != null && !(await s.artifact.stepTags()).includes(Number(step))) throw new HttpError(404, `no step ${step}`);
        return engine.bundle(s, step == null ? undefined : Number(step));
      },
    ],
    [
      'GET',
      /^\/atoll\/harness\/install$/,
      async ({ scenario, url, req, res }) => {
        const target = url.searchParams.get('target') ?? url.searchParams.get('adapter') ?? 'claude-code';
        if (target !== 'claude-code') throw new HttpError(422, `unknown target "${target}" (supported: claude-code)`);
        await store.ensure(scenario);
        const base = cfg.publicUrl ?? `http://${req.headers.host}`;
        send(res, 200, installScript({ url: base, token: cfg.token, scenario }), { 'content-type': 'text/x-shellscript; charset=utf-8' });
      },
    ],
    ['GET', /^\/atoll\/harness\/client\.mjs$/, async ({ res }) => send(res, 200, CLIENT_SOURCE, { 'content-type': 'text/javascript; charset=utf-8' })],
  ];

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://atoll.local');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = DASHBOARD.replace('__ATOLL_DEFAULT_TOKEN__', cfg.token === DEFAULTS.token ? DEFAULTS.token : '');
        return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
      }
      if (url.pathname !== '/healthz' && !authorized(req, url)) {
        const inferencePath = url.pathname.startsWith('/v1/');
        return send(res, 401, inferencePath ? providerError(url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 401, 'invalid atoll token') : { error: 'missing or invalid token (Authorization: Bearer <token>)' });
      }
      if (req.method === 'GET' && url.pathname === '/atoll/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        listeners.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          listeners.delete(res);
        });
        return;
      }
      let methodMismatch = false;
      for (const [method, pattern, handler] of routes) {
        const m = url.pathname.match(pattern);
        if (!m) continue;
        if (method !== req.method) {
          methodMismatch = true;
          continue;
        }
        const body = method === 'POST' && !url.pathname.startsWith('/v1/') ? await readJson(req, cfg.maxBodyBytes) : {};
        const result = await handler({ req, res, url, body, params: m.slice(1), scenario: scenarioName(req, url) });
        if (res.headersSent || res.writableEnded) return;
        const [status, payload] = Array.isArray(result) ? result : [200, result];
        return send(res, status, payload);
      }
      send(res, methodMismatch ? 405 : 404, { error: methodMismatch ? 'method not allowed' : `no route ${req.method} ${url.pathname}` });
    } catch (e) {
      if (!e.status || e.status >= 500) log(`${req.method} ${url.pathname}: ${e.stack ?? e.message}`);
      send(res, e.status ?? 500, { error: e.message, ...(e.details ? { details: e.details } : {}) });
    }
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, resolve);
    });
  } catch (e) {
    if (!cfg.runtimeInstance) await runtime?.close();
    throw e;
  }
  const address = server.address();
  const url = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
  return {
    cfg,
    url,
    server,
    store,
    engine,
    provider,
    runtime,
    recipe,
    async close() {
      for (const res of listeners) res.end();
      for (const t of engine.timers.values()) clearTimeout(t);
      for (const run of engine.discovery.runs.values()) run.stopped = true;
      await new Promise((resolve) => server.close(() => resolve()));
      if (!cfg.runtimeInstance) await runtime?.close();
    },
  };
}

export function installScript({ url, token, scenario }) {
  const config = JSON.stringify({ url, token, scenario, record: true, autoUpdate: false }, null, 2);
  return `#!/usr/bin/env bash
# atoll — install the Claude Code harness for scenario "${scenario}" into the current directory.
#   curl -fsS -H "Authorization: Bearer $ATOLL_TOKEN" -H "x-atoll-scenario: ${scenario}" \\
#     '${url}/atoll/harness/install?target=claude-code' | bash
set -euo pipefail
command -v node >/dev/null 2>&1 || { echo "atoll: node >= 22 is required" >&2; exit 1; }
ROOT="\${ATOLL_PROJECT_DIR:-$PWD}"
DIR="$ROOT/.claude/atoll"
mkdir -p "$DIR"
cat > "$DIR/client.mjs" <<'ATOLL_CLIENT_EOF'
${CLIENT_SOURCE.replace(/\n$/, '')}
ATOLL_CLIENT_EOF
cat > "$DIR/config.new.json" <<'ATOLL_CONFIG_EOF'
${config}
ATOLL_CONFIG_EOF
printf '*\\n' > "$DIR/.gitignore"
node "$DIR/client.mjs" install-local
`;
}
