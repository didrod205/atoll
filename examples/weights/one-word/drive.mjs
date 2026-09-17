// A task stream through atoll, the way an application with a checker would run it:
// ask, check the answer, report a score — and a correction when it was wrong.
// Between rounds it measures exact-match accuracy on eval.jsonl, which is never
// trained on, through the same server (so it always hits the adapter serving now).
//
//   atoll serve --runtime mlx --model mlx-community/Qwen2.5-0.5B-Instruct-4bit \
//     --recipe imitate --min-batch 8 \
//     --eval-set examples/weights/one-word/eval.jsonl \
//     --verifier-cmd "node examples/weights/one-word/verify.mjs"
//   node examples/weights/one-word/drive.mjs --rounds 3

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const url = arg('url', process.env.ATOLL_URL ?? 'http://127.0.0.1:8901');
const token = arg('token', process.env.ATOLL_TOKEN ?? 'atoll-local');
const scenario = arg('scenario', 'one-word');
const rounds = Number(arg('rounds', 3));
const temperature = Number(arg('temperature', 0.7));
const load = (f) => readFileSync(join(here, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const train = load('train.jsonl');
const evals = load('eval.jsonl');
const headers = { authorization: `Bearer ${token}`, 'x-atoll-scenario': scenario, 'content-type': 'application/json' };

async function api(method, path, body) {
  const res = await fetch(url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error ?? res.status}`);
  return { json, res };
}

async function ask(prompt, temp) {
  const { json, res } = await api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: prompt }], max_tokens: 16, temperature: temp });
  return { text: json.choices[0].message.content.trim(), receipt: res.headers.get('x-atoll-record-id'), step: Number(res.headers.get('x-atoll-step')) };
}

async function settle() {
  // Training is scheduled a moment after reports arrive; wait until nothing is running or queued.
  let quiet = 0;
  while (quiet < 3) {
    await new Promise((r) => setTimeout(r, 1000));
    const { json } = await api('GET', `/atoll/scenarios/${scenario}`);
    const { json: c } = await api('GET', '/atoll/candidates');
    quiet = json.job || c.candidates.some((x) => x.status === 'running') ? 0 : quiet + 1;
  }
}

async function evaluate() {
  let correct = 0;
  let step;
  for (const t of evals) {
    const r = await ask(t.prompt, 0);
    step = r.step;
    if (r.text === t.expected) correct++;
  }
  return { correct, step };
}

await api('POST', '/atoll/scenarios', { name: scenario });
const before = await evaluate();
console.log(`held-out before: ${before.correct}/${evals.length} (step ${before.step})`);
for (let round = 1; round <= rounds; round++) {
  let correct = 0;
  for (const t of train) {
    const r = await ask(t.prompt, temperature);
    const ok = r.text === t.expected;
    if (ok) correct++;
    await api('POST', '/atoll/report', { score: ok ? 1 : 0, feedback: ok ? undefined : { correction: t.expected }, references: [r.receipt], source: 'drive' });
  }
  await settle();
  const after = await evaluate();
  const { json: v } = await api('GET', '/atoll/versions');
  const { json: c } = await api('GET', '/atoll/candidates');
  const decided = c.candidates.filter((x) => x.surface === 'weights').slice(0, 3).map((x) => `${x.status}${x.step ? `→${x.step}` : ''}`);
  console.log(`round ${round}: stream ${correct}/${train.length} · held-out ${after.correct}/${evals.length} · serving step ${after.step} · versions ${v.versions.length - 1} · latest candidates ${decided.join(', ')}`);
}
