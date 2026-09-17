// An in-process runtime with learnable, deterministic behavior. An adapter is a
// memory of prompt → preferred response: training writes to it, generation reads
// from it, and scoring reports low loss for what the adapter would say. Enough
// to exercise the whole weights path — train, evaluate, publish, hot-swap,
// roll back — without a model.

import { createProvider } from '../providers.js';
import { HttpError } from '../util.js';

const keyOf = (messages = []) => ([...messages].reverse().find((m) => m.role === 'user')?.content ?? '').trim();

export function mockRuntime(cfg = {}) {
  const base = createProvider({ upstream: 'mock', upstreamModel: 'mock-lm' });
  const adapters = new Map();
  const model = cfg.model || 'mock-lm';
  let jobs = 0;

  const preferred = (name, key) => {
    if (!name || name === 'base') return undefined;
    const a = adapters.get(name);
    if (!a) throw new HttpError(404, `runtime mock: adapter "${name}" is not loaded`);
    return a.memory[key] ?? a.memory['*'];
  };

  const runtime = {
    name: 'mock',
    engine: 'mock',
    model,
    lora: { rank: 8, layers: 16, scale: 20 },
    trainable: true,
    adapterExt: 'json',
    calls: { generate: 0, train: 0 },

    async describe() {
      return this.health();
    },

    async health() {
      return { ok: true, protocol: 1, engine: 'mock', model, lora: this.lora, adapters: [...adapters.keys()].sort(), jobs: {} };
    },

    async generate({ adapter, system, messages, maxTokens, temperature }) {
      this.calls.generate++;
      const learned = preferred(adapter, keyOf(messages));
      if (learned !== undefined) return { text: learned, adapter, finishReason: 'stop', usage: { input: 10, output: 5 } };
      const r = await base.complete({ system: system ?? '', messages, maxTokens, temperature });
      return { text: r.text, adapter: adapter || 'base', finishReason: 'stop', usage: r.usage };
    },

    async score({ adapter, examples }) {
      const out = [];
      for (const ex of examples) {
        const learned = preferred(adapter, keyOf(ex.messages));
        const target = learned ?? (await base.complete({ system: ex.system ?? '', messages: ex.messages })).text;
        out.push(ex.response === target ? 0.2 : 2.0);
      }
      return out;
    },

    async train({ adapter, kind, startFrom, examples, hyper }, onProgress = () => {}) {
      this.calls.train++;
      hyper ??= {};
      const id = `mockjob${++jobs}`;
      const view = (status, extra = {}) => ({ id, adapter, kind, status, step: examples.length, total: examples.length, loss: 0.1, losses: [1, 0.5, 0.1], error: null, seconds: 0, ...extra });
      onProgress(view('running', { step: 0, loss: null, losses: [] }));
      if (hyper.fail) {
        onProgress(view('failed', { error: 'mock failure requested' }));
        throw new HttpError(502, 'training failed: mock failure requested');
      }
      const memory = { ...(startFrom && startFrom !== 'base' ? adapters.get(startFrom)?.memory : {}) };
      const byKey = new Map();
      for (const ex of examples) {
        const key = keyOf(ex.messages);
        const value = kind === 'pg' ? ex.advantage : ex.weight ?? 1;
        const best = byKey.get(key);
        if (!best || value > best.value) byKey.set(key, { response: ex.response, value });
        if (kind === 'pg' && value < 0 && memory[key] === ex.response) delete memory[key];
      }
      for (const [key, { response, value }] of byKey) if (value > 0) memory[key] = response;
      if (hyper.overfit) memory['*'] = [...byKey.values()].find((b) => b.value > 0)?.response ?? 'overfit';
      adapters.set(adapter, { memory });
      const done = view('done');
      onProgress(done);
      return done;
    },

    async download(adapter) {
      const a = adapters.get(adapter);
      if (!a) throw new HttpError(404, `runtime mock: adapter "${adapter}" is not loaded`);
      return Buffer.from(JSON.stringify({ format: 'atoll-mock-adapter', model, memory: a.memory }));
    },

    async upload(adapter, bytes) {
      let data;
      try {
        data = JSON.parse(Buffer.from(bytes).toString('utf8'));
      } catch {
        throw new HttpError(400, 'runtime mock: not a mock adapter');
      }
      if (data.format !== 'atoll-mock-adapter') throw new HttpError(400, 'runtime mock: not a mock adapter');
      if (data.model !== model) throw new HttpError(409, `runtime mock: adapter was trained for ${data.model}`);
      adapters.set(adapter, { memory: data.memory });
      return { adapter, tensors: Object.keys(data.memory).length };
    },

    async remove(adapter) {
      adapters.delete(adapter);
    },

    loaded: () => [...adapters.keys()],
    async close() {},
  };
  return runtime;
}
