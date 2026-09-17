// CLI for the weights and discovery surfaces: runtime setup, adapter export,
// discovery runs, and their offline demos.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProblem } from './discovery.js';
import { createRuntime, MLX_PACKAGES, mlxPython, RUNTIME_DIR, RuntimeClient } from './runtime/index.js';
import { createServer } from './server.js';

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const tty = process.stdout.isTTY;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const teal = (s) => (tty ? `\x1b[36m${s}\x1b[0m` : s);
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

// --- atoll runtime ---------------------------------------------------------------

export async function runtimeCommand({ positional, flags }, serverOptions) {
  const [sub, engine] = positional;
  if (sub === 'install') {
    if (engine !== 'mlx') throw new Error('usage: atoll runtime install mlx');
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('MLX needs macOS on Apple Silicon — on other machines run a GPU worker and use --runtime remote');
    const venv = dirname(dirname(mlxPython(flags)));
    const python = flags.python3 ?? 'python3';
    console.log(`${bold('atoll runtime install mlx')}\n  venv      ${venv}\n  packages  ${MLX_PACKAGES.join(' ')} and their dependencies (~150 MB from PyPI)\n  models    are downloaded from Hugging Face on first use by --model\n`);
    mkdirSync(dirname(venv), { recursive: true });
    if (!existsSync(join(venv, 'bin', 'python'))) await run(python, ['-m', 'venv', venv]);
    await run(join(venv, 'bin', 'pip'), ['install', '--disable-pip-version-check', ...MLX_PACKAGES]);
    await run(join(venv, 'bin', 'python'), ['-c', 'import mlx.core as mx, mlx_lm; print("mlx", mx.__version__, "mlx-lm", mlx_lm.__version__, "metal", mx.metal.is_available())']);
    console.log(`\n${green('ready')} — try: atoll runtime check --model mlx-community/Qwen2.5-0.5B-Instruct-4bit`);
    return;
  }
  if (sub === 'check') return runtimeCheck(flags, serverOptions);
  if (sub === 'where' || !sub) {
    console.log(`runtime dir  ${RUNTIME_DIR}\nmlx python   ${mlxPython(flags)} ${existsSync(mlxPython(flags)) ? green('(installed)') : red('(not installed — atoll runtime install mlx)')}`);
    return;
  }
  throw new Error('usage: atoll runtime install mlx | check [--model id | --runtime-url url --runtime-token t] | where');
}

/** Walk every protocol endpoint against a runtime and report each step. */
async function runtimeCheck(flags, serverOptions) {
  const opts = serverOptions(flags);
  const remote = opts.runtimeUrl != null;
  const runtime = remote
    ? new RuntimeClient({ url: opts.runtimeUrl, token: opts.runtimeToken ?? process.env.ATOLL_RUNTIME_TOKEN ?? '', name: 'remote' })
    : await createRuntime({ ...opts, runtime: flags.runtime ?? 'mlx' }, (m) => console.log(dim(`  ${m}`)));
  runtime.pollMs = 200;
  const results = [];
  const step = async (label, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push(true);
      console.log(`  ${green('✓')} ${label.padEnd(34)} ${dim(`${Date.now() - started} ms`)}${detail ? `  ${detail}` : ''}`);
    } catch (e) {
      results.push(false);
      console.log(`  ${red('✗')} ${label.padEnd(34)} ${e.message}`);
    }
  };
  const q = { messages: [{ role: 'user', content: 'What is the secret word?' }] };
  const name = `check.${Date.now().toString(36)}`;
  console.log(bold(`atoll runtime check — ${remote ? opts.runtimeUrl : runtime.name}`));
  try {
    await step('health', async () => {
      const h = await (runtime.describe ? runtime.describe() : runtime.health());
      if (h.protocol !== 1) throw new Error(`protocol ${h.protocol}`);
      return `${h.engine} · ${h.model} · rank ${h.lora?.rank} · ${h.lora?.layers} layers`;
    });
    let base;
    await step('generate (base)', async () => {
      base = (await runtime.generate({ ...q, adapter: null, maxTokens: 24, temperature: 0 })).text;
      return JSON.stringify(base.slice(0, 60));
    });
    await step('train sft (keeps serving)', async () => {
      const training = runtime.train({ adapter: name, kind: 'sft', examples: [{ ...q, response: 'The secret word is coral.' }], hyper: { steps: 20 } });
      const during = await runtime.generate({ ...q, adapter: null, maxTokens: 8, temperature: 0 });
      const job = await training;
      if (!base.startsWith(during.text.slice(0, 10))) throw new Error('base output changed while training');
      return `${job.total} steps, loss ${job.loss}, ${job.seconds}s`;
    });
    await step('generate (trained adapter)', async () => {
      const t = (await runtime.generate({ ...q, adapter: name, maxTokens: 24, temperature: 0 })).text;
      if (!/coral/i.test(t)) throw new Error(`adapter did not learn: ${JSON.stringify(t)}`);
      return JSON.stringify(t);
    });
    let bytes;
    await step('download adapter', async () => {
      bytes = await runtime.download(name);
      return `${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
    });
    await step('upload adapter (hot swap)', async () => {
      await runtime.upload(`${name}.copy`, bytes);
      const t = (await runtime.generate({ ...q, adapter: `${name}.copy`, maxTokens: 24, temperature: 0 })).text;
      if (!/coral/i.test(t)) throw new Error('uploaded copy behaves differently');
      return 'copy answers the same';
    });
    await step('score', async () => {
      const [trained] = await runtime.score({ adapter: name, examples: [{ ...q, response: 'The secret word is coral.' }] });
      const [untrained] = await runtime.score({ adapter: null, examples: [{ ...q, response: 'The secret word is coral.' }] });
      if (!(trained < untrained)) throw new Error(`trained NLL ${trained} is not below base ${untrained}`);
      return `NLL base ${untrained.toFixed(3)} → adapter ${trained.toFixed(3)}`;
    });
    await step('delete adapters', async () => {
      await runtime.remove(name);
      await runtime.remove(`${name}.copy`);
    });
  } finally {
    await runtime.close?.();
  }
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed === results.length ? green('pass') : red('fail')} ${passed}/${results.length}`);
  if (passed !== results.length) process.exitCode = 1;
}

// --- atoll weights ---------------------------------------------------------------

export async function weightsCommand({ positional, flags }, call, clientConfig) {
  const c = clientConfig(flags);
  const [sub, stepArg] = positional;
  if (sub === 'export') {
    const step = Number(stepArg);
    if (!Number.isInteger(step)) throw new Error('usage: atoll weights export <step> [--out dir]');
    const versions = await call(c, 'GET', `/atoll/versions/${step}`);
    const res = await fetch(`${c.url}/atoll/weights/${step}/adapter`, { headers: { authorization: `Bearer ${c.token}`, 'x-atoll-scenario': c.scenario } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const out = resolve(flags.out ?? `${c.scenario}-step-${step}`);
    mkdirSync(out, { recursive: true });
    const { manifest } = await call(c, 'GET', `/atoll/weights?step=${step}`);
    if (res.headers.get('content-disposition')?.includes('.safetensors')) {
      writeFileSync(join(out, 'adapters.safetensors'), bytes);
      const lora = manifest.lora ?? {};
      // The layout mlx_lm.load(..., adapter_path=out) and mlx_lm.generate --adapter-path read.
      writeFileSync(
        join(out, 'adapter_config.json'),
        `${JSON.stringify({ fine_tune_type: 'lora', num_layers: lora.layers ?? 16, lora_parameters: { rank: lora.rank ?? 8, scale: lora.scale ?? 20, dropout: 0 }, model: manifest.model ?? null, atoll: { scenario: c.scenario, step, sha256: res.headers.get('x-atoll-adapter-sha256') } }, null, 2)}\n`,
      );
    } else writeFileSync(join(out, 'adapter.json'), bytes);
    console.log(`exported step ${step} (${versions.summary}) → ${out}${manifest.model ? `\n  use it: mlx_lm.generate --model ${manifest.model} --adapter-path ${out} --prompt "..."` : ''}`);
    return;
  }
  const w = await call(c, 'GET', '/atoll/weights');
  if (!w.manifest) return console.log(`scenario ${c.scenario}: no adapter yet (step ${w.step} serves the base model)`);
  const m = w.manifest;
  console.log(`scenario ${c.scenario} · step ${w.step} · ${m.recipe}\n  adapter  ${m.sha256.slice(0, 16)} (${(m.bytes / 1e6).toFixed(1)} MB) for ${m.model}\n  trained  ${m.examples} example(s), ${m.steps} step(s), loss ${m.loss}\n  eval     ${m.eval?.summary ?? m.eval?.error ?? 'n/a'}\n  serving  ${w.serving ?? '(base model)'}`);
}

// --- atoll discover ----------------------------------------------------------------

export async function discoverCommand({ positional, flags }, serverOptions) {
  const dir = positional[0];
  if (!dir) throw new Error('usage: atoll discover <problem-dir> [--attempts n] [--tune-every n] [-s scenario] [--upstream ...|--runtime mlx --model id]');
  const problem = loadProblem(dir);
  const opts = serverOptions(flags);
  const app = await createServer({ ...opts, port: flags.port != null ? Number(flags.port) : 0, log: flags.verbose ? undefined : () => {} });
  const scenario = flags.scenario ?? problem.name;
  const s = await app.store.ensure(scenario);
  const attempts = flags.attempts != null ? Number(flags.attempts) : problem.attempts;
  console.log(`${bold('atoll discover')} ${problem.name} — ${problem.objective}, ${attempts} attempt(s), proposer ${app.provider.name}${app.provider.model ? ` · ${app.provider.model}` : ''}`);
  console.log(dim(`  scenario ${scenario} · state ${resolve(opts.state ?? '.atoll')} · dashboard ${app.url}/`));
  if (problem.sandbox === 'none') console.log(dim(`  note: model-written code runs on this machine via "${problem.evaluate}" — set "sandbox": "macos" in problem.json to block network access and writes outside the attempt and temp directories`));
  const started = Date.now();
  app.engine.on('event', (e) => {
    if (e.scenario !== scenario || e.type !== 'discovery') return;
    if (e.event === 'attempt' && e.status !== 'running') {
      const c = s.candidates.get(e.id);
      const mark = e.status === 'accepted' ? green(`★ step ${e.step}`) : e.status === 'rejected' ? dim('·') : red('✗');
      const score = c.attempt.score != null ? String(Number(c.attempt.score.toFixed(6))) : '—';
      console.log(`  ${String(c.attempt.n).padStart(3)}  ${mark.padEnd(tty ? 18 : 9)} ${score.padEnd(12)} ${dim((c.attempt.idea || c.decision?.reason || '').slice(0, 90))}`);
    }
    if (e.event === 'tune-start') console.log(teal(`       tuning the proposer on ${e.examples} scored attempt(s)…`));
    if (e.event === 'tune') console.log(teal(`       tuned → ${e.adapter} (loss ${e.loss}, ${e.seconds}s)`));
    if (e.event === 'tune-failed') console.log(red(`       tuning failed: ${e.reason}`));
    if (e.event === 'tune-kept') console.log(teal(`       kept ${e.adapter}: ${e.reason}`));
    if (e.event === 'tune-reverted') console.log(red(`       reverted ${e.adapter}: ${e.reason}`));
  });
  const stop = () => {
    const current = app.engine.discovery.runs.get(scenario);
    if (current) current.stopped = true;
    console.log(dim('  stopping after the current attempt…'));
  };
  process.once('SIGINT', stop);
  const run = app.engine.discovery.start(s, problem, { attempts, tuneEvery: flags.tuneEvery != null ? Number(flags.tuneEvery) : undefined });
  const view = await run.promise;
  process.removeListener('SIGINT', stop);
  const best = view.best;
  console.log(
    `\n${bold(view.status)} in ${((Date.now() - started) / 1000).toFixed(1)}s — best ${best ? `${best.score} (attempt ${s.candidates.get(best.candidate).attempt.n}, step ${best.step})` : 'none'}${view.tuning ? ` · tuned ${view.tuning.runs}×` : ''}`,
  );
  if (best && !flags.ephemeral) console.log(dim(`  solution: ${join(s.dir, 'artifact', 'discovery', problem.solution.file)}`));
  if (flags.keepServing) {
    console.log(`dashboard stays up at ${app.url}/ — Ctrl-C to stop`);
    await new Promise((r) => process.once('SIGINT', r));
  }
  await app.close();
  return view;
}

// --- demos -----------------------------------------------------------------------------

export async function demoWeights(flags, serverOptions, call) {
  const work = mkdtempSync(join(tmpdir(), 'atoll-demo-weights-'));
  const runtime = flags.runtime ?? 'mock';
  const app = await createServer({ ...serverOptions(flags), runtime, recipe: flags.recipe ?? 'imitate', minBatch: 2, port: 0, state: join(work, 'state'), debounceMs: 100, log: () => {} });
  const c = { url: app.url, token: app.cfg.token, scenario: 'weights-demo' };
  const chat = async (content) => {
    const res = await fetch(`${app.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.token}`, 'x-atoll-scenario': c.scenario, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content }], temperature: 0, max_tokens: 60 }),
    });
    const json = await res.json();
    return { receipt: res.headers.get('x-atoll-record-id'), text: json.choices?.[0]?.message?.content ?? JSON.stringify(json), step: res.headers.get('x-atoll-step') };
  };
  const say = (n, label, text) => console.log(`\n${teal(n)} ${bold(label)}  ${dim(text)}`);
  try {
    console.log(`${bold('atoll demo weights')} — runtime ${app.runtime.name} · ${app.runtime.model}${runtime === 'mock' ? ' (deterministic, offline)' : ''}`);
    const qs = ['What is the motto of the reef keepers?', 'Who keeps the reef?'];
    const fixes = ['Grow slowly, hold fast.', 'The reef keepers do.'];
    say('1', 'Serve', 'the base model answers, each reply with a receipt');
    const first = [];
    for (const q of qs) {
      const r = await chat(q);
      first.push(r);
      console.log(`  ${q}\n    ${dim('→')} ${JSON.stringify(r.text.slice(0, 80))}  ${dim(r.receipt)}`);
    }
    say('2', 'Observe', 'corrections come back as feedback on those receipts');
    for (const [i, r] of first.entries()) {
      await call(c, 'POST', '/atoll/report', { score: 0, feedback: { correction: fixes[i] }, references: [r.receipt] });
      console.log(`  correction → ${JSON.stringify(fixes[i])}`);
    }
    say('3', 'Grow', `the runtime trains a LoRA adapter (${app.recipe.name}), then evaluates it against the serving one`);
    const s = app.store.get(c.scenario);
    const t0 = Date.now();
    while (![...s.candidates.values()].some((x) => x.status !== 'running') || app.engine.running.size || app.engine.timers.size) {
      if (Date.now() - t0 > 900_000) throw new Error('timed out waiting for training');
      await new Promise((r) => setTimeout(r, 200));
    }
    const cand = [...s.candidates.values()].pop();
    console.log(`  ${cand.id}  ${cand.status}${cand.step ? ` → step ${cand.step}` : ''}\n    train  ${cand.train?.examples} example(s), ${cand.train?.steps} step(s), loss ${cand.train?.loss}\n    eval   ${dim(cand.checks.eval?.reason ?? cand.checks.eval?.error ?? '')}`);
    say('4', 'Commit + hot swap', 'the same server now answers from the new adapter — no restart');
    for (const q of qs) {
      const r = await chat(q);
      console.log(`  ${q}\n    ${dim('→')} ${JSON.stringify(r.text.slice(0, 80))}  ${dim(`step ${r.step}`)}`);
    }
    const w = await call(c, 'GET', '/atoll/weights');
    console.log(`  adapter ${w.manifest?.sha256.slice(0, 16)} · ${((w.manifest?.bytes ?? 0) / 1e6).toFixed(2)} MB · serving ${w.serving}`);
    say('5', 'Roll back', 'publish step 0 again; serving swaps back');
    await call(c, 'POST', '/atoll/versions/0/rollback');
    console.log(`  ${qs[0]}\n    ${dim('→')} ${JSON.stringify((await chat(qs[0])).text.slice(0, 80))}`);
    console.log(`\n${bold('Done.')} Real training on Apple Silicon: ${teal('atoll runtime install mlx')} then ${teal('atoll demo weights --runtime mlx --model mlx-community/Qwen2.5-0.5B-Instruct-4bit')}`);
  } finally {
    await app.close();
    if (!flags.keep) rmSync(work, { recursive: true, force: true });
  }
}

export async function demoDiscovery(flags, serverOptions) {
  const work = mkdtempSync(join(tmpdir(), 'atoll-demo-discovery-'));
  try {
    const problem = flags.problem ?? join(EXAMPLES, 'discovery', 'circle-packing');
    await discoverCommand(
      { positional: [problem], flags: { upstream: 'mock', attempts: 30, ...flags, state: join(work, 'state'), scenario: 'discovery-demo', ephemeral: !flags.keep } },
      serverOptions,
    );
    console.log(`\n${bold('Done.')} With a real proposer: ${teal(`atoll discover ${problem} --upstream claude --attempts 40`)}`);
  } finally {
    if (!flags.keep) rmSync(work, { recursive: true, force: true });
  }
}

export const exampleProblem = (name) => join(EXAMPLES, 'discovery', name);
export const readExample = (p) => readFileSync(join(EXAMPLES, p), 'utf8');
