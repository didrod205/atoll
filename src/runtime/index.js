// Runtimes: engines that serve a model *and* train adapters for it.
//
//   mlx     a local Python worker on Apple Silicon, spawned and supervised here
//   remote  any server that speaks runtime/PROTOCOL.md (a GPU box, for example)
//   mock    an in-process stand-in with learnable behavior, for tests and demos

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../util.js';
import { mockRuntime } from './mock.js';

export const RUNTIMES = ['mlx', 'remote', 'mock'];
export const RUNTIME_DIR = process.env.ATOLL_RUNTIME_DIR || join(homedir(), '.atoll', 'runtime');
export const MLX_WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'runtime', 'mlx', 'worker.py');
export const MLX_PACKAGES = ['mlx==0.32.2', 'mlx-lm==0.31.3'];

export function mlxPython(cfg = {}) {
  return cfg.python || process.env.ATOLL_MLX_PYTHON || join(RUNTIME_DIR, 'mlx', 'bin', 'python');
}

export async function createRuntime(cfg, log = () => {}) {
  switch (cfg.runtime) {
    case 'mlx':
      return spawnMlx(cfg, log);
    case 'remote': {
      if (!cfg.runtimeUrl) throw new Error('--runtime-url is required with --runtime remote');
      const client = new RuntimeClient({ url: cfg.runtimeUrl, token: cfg.runtimeToken ?? process.env.ATOLL_RUNTIME_TOKEN ?? '', name: 'remote' });
      await client.describe();
      return client;
    }
    case 'mock':
      return mockRuntime(cfg);
    default:
      throw new Error(`unknown runtime "${cfg.runtime}" (expected one of ${RUNTIMES.join(', ')})`);
  }
}

export class RuntimeClient {
  constructor({ url, token, name, onClose }) {
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.name = name;
    this.onClose = onClose;
    this.trainable = true;
    this.dead = null;
    this.adapterExt = 'safetensors';
  }

  async request(method, path, { json, body, raw = false, timeout = 600_000, signal } = {}) {
    if (this.dead) throw new HttpError(502, `runtime ${this.name} is not running: ${this.dead}`);
    let res;
    try {
      res = await fetch(this.url + path, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(body !== undefined ? { 'content-type': 'application/octet-stream' } : {}),
        },
        body: json !== undefined ? JSON.stringify(json) : body,
        signal: signal ?? AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw new HttpError(502, `runtime ${this.name} unreachable at ${this.url}: ${e.cause?.code ?? e.message}`);
    }
    if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 300) };
    }
    if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : res.status, `runtime ${this.name}: ${data.error ?? `HTTP ${res.status}`}`);
    return data;
  }

  async describe() {
    const h = await this.request('GET', '/v1/health', { timeout: 15_000 });
    if (h.protocol !== 1) throw new Error(`runtime at ${this.url} speaks protocol ${h.protocol}; atoll needs 1`);
    this.model = h.model;
    this.lora = h.lora;
    this.engine = h.engine;
    return h;
  }

  health() {
    return this.request('GET', '/v1/health', { timeout: 15_000 });
  }

  async generate({ adapter, system, messages, maxTokens, temperature, signal }) {
    const r = await this.request('POST', '/v1/generate', {
      json: { adapter: adapter ?? null, system: system || undefined, messages, max_tokens: maxTokens ?? 512, temperature },
      signal,
    });
    return { text: r.text, adapter: r.adapter, finishReason: r.finish_reason, usage: { input: r.usage?.input ?? 0, output: r.usage?.output ?? 0 } };
  }

  async score({ adapter, examples }) {
    return (await this.request('POST', '/v1/score', { json: { adapter: adapter ?? null, examples } })).nll;
  }

  /** Start a job and wait for it; onProgress sees each poll. */
  async train({ adapter, kind, startFrom, examples, hyper }, onProgress = () => {}) {
    let job = await this.request('POST', '/v1/train', { json: { adapter, kind, start_from: startFrom ?? null, examples, hyper: hyper ?? {} } });
    while (job.status === 'running') {
      onProgress(job);
      await new Promise((r) => setTimeout(r, this.pollMs ?? 500));
      job = await this.request('GET', `/v1/train/${job.id}`);
    }
    onProgress(job);
    if (job.status !== 'done') throw new HttpError(502, `training failed: ${job.error ?? job.status}`);
    return job;
  }

  download(adapter) {
    return this.request('GET', `/v1/adapters/${encodeURIComponent(adapter)}/file`, { raw: true });
  }

  upload(adapter, bytes) {
    return this.request('PUT', `/v1/adapters/${encodeURIComponent(adapter)}`, { body: bytes });
  }

  async remove(adapter) {
    try {
      await this.request('DELETE', `/v1/adapters/${encodeURIComponent(adapter)}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }

  async close() {
    await this.onClose?.();
  }
}

async function spawnMlx(cfg, log) {
  const python = mlxPython(cfg);
  if (!existsSync(python)) {
    throw new Error(`MLX runtime is not installed (no ${python}) — run: atoll runtime install mlx`);
  }
  if (!cfg.model) throw new Error('--model is required with --runtime mlx (e.g. mlx-community/Qwen2.5-0.5B-Instruct-4bit)');
  const token = randomBytes(16).toString('hex');
  const args = [
    MLX_WORKER,
    '--model', cfg.model,
    '--port', '0',
    '--parent-pid', String(process.pid),
    '--lora-rank', String(cfg.loraRank ?? 8),
    '--lora-layers', String(cfg.loraLayers ?? 16),
    '--max-seq', String(cfg.maxSeq ?? 1024),
  ];
  const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ATOLL_WORKER_TOKEN: token, PYTHONUNBUFFERED: '1' } });
  const tail = [];
  let partial = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const lines = (partial + chunk).split(/\r?\n|\r/);
    partial = lines.pop();
    for (const line of lines.filter(Boolean)) {
      tail.push(line);
      if (tail.length > 40) tail.shift();
      if (line.startsWith('[atoll-mlx]')) log(line.replace('[atoll-mlx] ', 'mlx: '));
    }
  });
  const ready = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`MLX worker did not start within ${Math.round((cfg.runtimeStartTimeoutMs ?? 1_800_000) / 1000)}s\n${tail.join('\n')}`));
    }, cfg.runtimeStartTimeoutMs ?? 1_800_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const m = out.match(/^ATOLL_WORKER_READY (.+)$/m);
      if (m) {
        clearTimeout(timer);
        resolve(JSON.parse(m[1]));
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`MLX worker exited (${code ?? signal}) before it was ready\n${tail.slice(-15).join('\n')}`));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${python}: ${e.message}`));
    });
  });
  const client = new RuntimeClient({
    url: `http://127.0.0.1:${ready.port}`,
    token,
    name: 'mlx',
    onClose: () =>
      new Promise((resolve) => {
        if (child.exitCode != null) return resolve();
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      }),
  });
  child.on('exit', (code, signal) => {
    client.dead = `exited (${code ?? signal})`;
    if (!client.closing) log(`mlx: worker exited (${code ?? signal})\n${tail.slice(-10).join('\n')}`);
  });
  const close = client.close.bind(client);
  client.close = () => {
    client.closing = true;
    return close();
  };
  await client.describe();
  return client;
}

/** A runtime as the model behind inference: each scenario is served by its current adapter. */
export function runtimeProvider(runtime, adapterFor) {
  return {
    name: `runtime:${runtime.name}`,
    native: null,
    get model() {
      return runtime.model;
    },
    async complete(c, { scenario, adapter, signal } = {}) {
      const use = adapter !== undefined ? adapter : scenario ? await adapterFor(scenario) : null;
      const r = await runtime.generate({ adapter: use, system: c.system, messages: c.messages, maxTokens: c.maxTokens, temperature: c.temperature, signal });
      return { text: r.text, model: runtime.model, adapter: use, stopReason: r.finishReason === 'length' ? 'max_tokens' : 'end', usage: r.usage };
    },
  };
}
