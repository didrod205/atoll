# atoll

[![npm version](https://img.shields.io/npm/v/atoll-harness.svg?color=success)](https://www.npmjs.com/package/atoll-harness)
[![node](https://img.shields.io/node/v/atoll-harness.svg)](https://www.npmjs.com/package/atoll-harness)
[![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/atoll-harness?activeTab=dependencies)
[![license](https://img.shields.io/npm/l/atoll-harness.svg)](https://github.com/didrod205/atoll/blob/main/LICENSE)

**An agent that keeps getting better from how you use it.** atoll serves your agent, records feedback on each response, grows an update from that feedback, checks the update, and publishes it as a numbered version — without taking the agent down. Three things can grow:

| | grows | from | runs on |
|---|---|---|---|
| **harness** | rules, skills, slash commands and hooks for Claude Code | asks, thumbs-downs, corrections in chat | your Claude Code login — no GPU, no API key |
| **weights** | a LoRA adapter on a model atoll serves, hot-swapped in | scores and corrections on responses | Apple Silicon (MLX), or any GPU box that speaks [the runtime protocol](runtime/PROTOCOL.md) |
| **discovery** | the best solution to one hard problem | an evaluator that scores every attempt | any model; with MLX, the proposer also trains on its own attempts |

[한국어 README](https://github.com/didrod205/atoll/blob/main/README.ko.md)

```bash
npx atoll-harness demo              # harness: an ask becomes a rule and a skill in a Claude Code project
npx atoll-harness demo weights      # weights: corrections train an adapter, serving hot-swaps to it
npx atoll-harness demo discovery    # discovery: 30 attempts at packing 26 circles in a square
```

All three demos run offline in a few seconds on a deterministic mock model. The runtime itself has no npm dependencies.

![atoll dashboard: versions and candidates on the left, feedback on the right](https://raw.githubusercontent.com/didrod205/atoll/main/docs/dashboard.png)

<sub>The dashboard, showing seeded example data for the harness surface: three published steps, one candidate rejected by static checks, one hook held until promoted, and an implicit correction picked up from a session.</sub>

---

## How it works

The ideas come from [Reef](https://github.com/Human-Agent-Society/reef); the code, names and interfaces are atoll's own. Every surface runs the same four steps:

| Step | What happens | Where it lives |
|---|---|---|
| **1 · Serve** | OpenAI- and Anthropic-compatible endpoints. Every response carries an `x-atoll-record-id` receipt. Claude Code sessions are recorded by a `Stop` hook instead. | `src/server.js`, `src/providers.js`, `src/runtime/` |
| **2 · Observe** | Reports (score and/or feedback + receipts), plain-language asks, implicit corrections ("no, use pnpm") and evaluator scores are matched to recorded interactions. | `src/observe.js`, `src/store.js` |
| **3 · Grow** | A recipe turns open feedback into an update: file changes for the harness, a training job for the weights, a new attempt for discovery. | `src/recipes/`, `src/engine.js`, `src/weights.js`, `src/discovery.js` |
| **4 · Commit** | The update is evaluated. Accepted ones become `step-N` in a per-scenario git history and go live; rejected ones leave the current version serving. | `src/evaluate.js`, `src/artifact.js` |

## Harness — Claude Code

**1. Start the server** (keep it running):

```bash
npm install -g atoll-harness
atoll serve
```

It uses the `claude` CLI, so run `claude` once and `/login` if you haven't. Other backends:

```bash
atoll serve --upstream anthropic --upstream-model claude-sonnet-5   # ATOLL_UPSTREAM_API_KEY
atoll serve --upstream openai --upstream-url http://127.0.0.1:11434 --upstream-model gemma4:26b   # Ollama, vLLM, ...
```

**2. Install the harness into a project** (from the project directory):

```bash
curl -fsS -H "Authorization: Bearer atoll-local" -H "x-atoll-scenario: my-harness" \
  'http://127.0.0.1:8901/atoll/harness/install?target=claude-code' | bash
```

This adds four slash commands, a `SessionStart` hook (update notice) and a `Stop` hook (records each finished turn to your local server), then installs the current version.

Hooks go into `.claude/settings.local.json`, your personal settings, never the shared `settings.json`. In a git repository, atoll's machine-specific files (the client, local settings, and the `atoll-*` commands, which carry this machine's path) are listed in `.git/info/exclude`, so they stay out of commits. The rules, skills and commands atoll writes are ordinary project files you can commit. `node .claude/atoll/client.mjs uninstall` removes everything it added.

**3. Work normally, and say what should change:**

```
/atoll-harness when I ask you to fix a bug, reproduce it with a failing test first
/atoll-report bad you ran npm again — this repo uses pnpm
/atoll-versions            # history; /atoll-versions 3 shows the diff
/atoll-versions 3 promote  # release a held hook
/atoll-versions 2 rollback # publish a new step identical to step 2
/atoll-update              # install the latest version
```

What lands in your project:

| Harness file | Installed as | Delivered |
|---|---|---|
| `rules/<name>.md` | a managed block in `CLAUDE.md` — your own text is never touched | immediately |
| `skills/<name>/SKILL.md` | `.claude/skills/<name>/` | immediately |
| `commands/<name>.md` | `.claude/commands/<name>.md` | immediately, unless it runs shell (`!` or `allowed-tools`) |
| `hooks/<name>.json` + script | `.claude/settings.local.json` + `.claude/atoll/hooks/` | **held until you promote the step** |

Anything that executes code on your machine is committed but held. A promotion is pinned to the file's content: if a later step changes the script, it is held again.

The next session starts with a notice when a new version is ready. Pushback at the start of a prompt ("no, …", "don't …", "아니 …", "그거 말고 …") becomes an implicit report on the previous turn. After two of them, the recipe decides whether they reflect a standing preference.

## Weights — train the model you serve

With a runtime, atoll serves a model itself and trains LoRA adapters on it. Each published step is an adapter; serving switches to it between requests, so traffic keeps flowing while a job trains and never sees a half-trained model.

```bash
atoll runtime install mlx        # Apple Silicon: a venv with mlx + mlx-lm under ~/.atoll/runtime
atoll runtime check --model mlx-community/Qwen2.5-0.5B-Instruct-4bit   # train, hot-swap, score once

atoll serve --runtime mlx --model mlx-community/Qwen2.5-0.5B-Instruct-4bit \
  --recipe imitate --min-batch 8 \
  --eval-set examples/weights/one-word/eval.jsonl \
  --verifier-cmd "node examples/weights/one-word/verify.mjs"
```

Send traffic to `/v1/chat/completions` and report on the receipts, exactly as in [the server example](#use-it-as-a-server). Two recipes turn reports into training:

| recipe | trains on | update |
|---|---|---|
| `imitate` | responses scored ≥ 0.5, and corrections sent as `{"feedback": {"correction": "..."}}` | supervised fine-tuning |
| `reinforce` | every scored response; the advantage is its score against other responses to the same prompt, or against the scenario's running average | policy gradient with a KL penalty to the base model |

Before a candidate adapter is published, atoll compares it with the adapter that is serving:

- **with `--eval-set` or `--verifier-cmd`** — both adapters answer the tasks (greedy), and the candidate must score at least as well (`--min-gain`).
- **without** — the candidate must make the good examples more likely than the serving adapter does, while its loss on the base model's own answers to generic prompts stays within `--retention-tolerance` of the base model's. That second check catches adapters that learn your feedback by forgetting everything else.

**Measured on a MacBook with an Apple A18 Pro and 8 GB**, with the command above and `node examples/weights/one-word/drive.mjs --rounds 4`, which asks 26 one-word questions per round, checks each answer, and reports a score plus a correction when it was wrong:

| | held-out accuracy (11 questions never trained on) | answers right in the round (26 questions, temperature 0.7) |
|---|---|---|
| base model | 5 / 11 | 7 / 26 |
| after 2 published steps | **9 / 11** | 22, 23, 24 / 26 in rounds 2–4 |

Six later candidates scored lower on the held-out set and were rejected, so step 2 kept serving. The whole run took under two minutes. Eleven questions is a small evaluation — treat the numbers as a demonstration, not a benchmark.

`atoll weights` shows the serving adapter; `atoll weights export 2 --out ./adapter` writes it in the layout `mlx_lm.generate --adapter-path` reads.

### Runtimes

| `--runtime` | |
|---|---|
| `mlx` | atoll spawns `runtime/mlx/worker.py` in the MLX venv and supervises it. `--model` is any mlx-lm model; `--lora-rank`, `--lora-layers`, `--max-seq`, `--train '{"lr":1e-5,"batch_size":4}'` tune training. |
| `remote` | `--runtime-url` + `ATOLL_RUNTIME_TOKEN`: any server that implements [runtime/PROTOCOL.md](runtime/PROTOCOL.md) — seven JSON endpoints — for example PyTorch + PEFT on a GPU box. `atoll runtime check --runtime-url ...` verifies an implementation end to end. |
| `mock` | in-process and deterministic, for tests and demos. |

## Discovery — many attempts at one hard problem

A problem is a directory: a task, a seed solution, and an evaluator that prints `{"valid", "score", "feedback"}`. atoll asks the model for a better solution, runs the evaluator on it in a scratch copy of the directory, and publishes every new best as a step. The prompt carries the best attempts so far with their scores and evaluator feedback, plus recent failures.

```bash
atoll discover examples/discovery/circle-packing --upstream claude --attempts 40
```

Output of `atoll demo discovery`, whose mock proposer only nudges numeric constants (★ = new best, published as a step; · = valid but not better; ✗ = invalid):

```
atoll discover circle-packing-26 — maximize, 30 attempt(s), proposer mock · mock-1
    0  ★ step 1  2.464        seed solution from the problem
    1  ·         2.412278     mock: constant #0 0.1 → 0.09
    2  ·         2.464        mock: constant #5 0.001 → 0.0009
    3  ·         2.4595       mock: constant #4 0.999 → 0.8991
    4  ★ step 2  2.4656       mock: constant #3 0.2 → 0.18
    5  ★ step 3  2.46704      mock: constant #2 0.5 → 0.45
```

With a trainable runtime the proposer also learns during the run: every `--tune-every` attempts, a policy-gradient step on its recent attempts (advantage = score relative to the others; invalid attempts and replies that break the format are negative) produces a new adapter that the next proposals use. A tuned adapter is on trial: if the attempts it proposes are less often valid than before and find no new best, atoll reverts to the previous proposer and waits a round before tuning again.

```bash
atoll discover examples/discovery/circle-packing --runtime mlx --model <id> --tune-every 8 --discovery-max-tokens 1024
```

`problem.json`:

```json
{
  "name": "circle-packing-26",
  "taskFile": "TASK.md",
  "solution": { "file": "solution.mjs", "language": "javascript", "seed": "seed.mjs" },
  "evaluate": "node evaluate.mjs solution.mjs",
  "objective": "maximize",
  "timeoutSeconds": 20,
  "budget": { "attempts": 40 },
  "target": 2.635,
  "sandbox": "none"
}
```

**Model-written code runs on your machine.** Each attempt runs in a fresh temporary copy of the problem directory with a timeout that kills the whole process group. On macOS, `"sandbox": "macos"` also denies network access and file writes outside the attempt directory and the system temp folders. For problems you do not trust, run atoll in a container or VM.

The dashboard plots every attempt with the best-so-far line; runs can also be started and stopped over HTTP (`POST /atoll/discovery {"problem": "<dir>", "attempts": 40}`).

## Use it as a server

Any client that speaks OpenAI or Anthropic can go through atoll. The scenario header picks what grows; a new name creates a scenario.

```python
import httpx

atoll = httpx.Client(
    base_url="http://127.0.0.1:8901",
    headers={"Authorization": "Bearer atoll-local", "x-atoll-scenario": "hello-atoll"},
    timeout=300,
)

response = atoll.post("/v1/chat/completions", json={
    "messages": [{"role": "user", "content": "Return exactly: atoll is ready"}],
})
receipt = response.headers["x-atoll-record-id"]
answer = response.json()["choices"][0]["message"]["content"]

matched = answer.strip() == "atoll is ready"
atoll.post("/atoll/report", json={
    "score": float(matched),
    "feedback": "matched" if matched else {"correction": "atoll is ready"},
    "references": [receipt],
}).raise_for_status()
```

`feedback` may be a string or an object. When the client speaks the upstream's own format (OpenAI → `--upstream openai`, Anthropic → `--upstream anthropic`), the body is forwarded untouched, so tools, images and streaming all pass through. Otherwise the conversation is translated as text.

<details>
<summary>Endpoints</summary>

| | |
|---|---|
| `POST /v1/chat/completions`, `POST /v1/messages` | inference; response headers `x-atoll-record-id`, `x-atoll-step` |
| `POST /atoll/report` | `{score?, feedback?, references: [receipt]}` |
| `POST /atoll/harness/ask` | `{text}` — a plain-language change request |
| `POST /atoll/records` | `{prompt, response, tools?, session?}` — interactions recorded outside atoll |
| `POST /atoll/grow` | run a learning cycle now |
| `GET /atoll/versions`, `GET /atoll/versions/:step` | history, one step's diff |
| `POST /atoll/versions/:step/promote` · `/rollback` | release held files · publish an older version as a new step |
| `GET /atoll/candidates[/:id]`, `POST /atoll/candidates/:id/accept` · `/reject` | review |
| `GET /atoll/harness/manifest` · `/bundle` · `/install?target=claude-code` | harness delivery |
| `GET /atoll/weights[?step=n]`, `GET /atoll/weights/:step/adapter` | the serving adapter; download one |
| `POST /atoll/discovery`, `GET /atoll/discovery`, `POST /atoll/discovery/stop` | discovery runs |
| `GET /atoll/scenarios`, `POST /atoll/scenarios` `{name, selection?}` | scenarios |
| `GET /atoll/events?token=` | server-sent events for live views |

Auth: `Authorization: Bearer <token>` or `x-api-key: <token>`. Scenario: `x-atoll-scenario` header or `?scenario=`.
</details>

## Deciding what ships

| `--selection` | harness candidate (after static checks) | weights candidate |
|---|---|---|
| `judge` (default) | published if the judge says every feedback item is addressed, finds no conflict with earlier feedback, and scores it ≥ `--threshold` (0.7) | published if the evaluation above passes |
| `manual` | held as *pending* until you accept or reject it | same — the adapter stays loaded for review |
| `always` | published | published |

`--evaluator-cmd "<shell>"` runs against a checkout of every harness candidate (`$ATOLL_HARNESS_DIR`); a non-zero exit rejects it. Discovery attempts are decided by the problem's evaluator alone.

A rejection goes back to the recipe with its reason on the next attempt. After two rejections a report is marked *stale* and stops being retried. You can accept a judge or evaluation rejection yourself; static-check failures cannot be overridden.

## Recipes

| recipe | surface | |
|---|---|---|
| `refine` (default) | harness | asks and feedback → rules, skills, commands, hooks |
| `basic` | harness | record only |
| `imitate` | weights | supervised fine-tuning on good responses and corrections |
| `reinforce` | weights | policy gradient on scored responses |
| `evolve` | discovery | used by `atoll discover` |

Or `--recipe ./my-recipe.mjs`:

```js
export default {
  name: 'my-recipe',
  triggers(report, openReports, { scenario, cfg }) { return report.kind === 'ask'; },   // wake the grower?
  select(openReports, { scenario, cfg }) { return openReports.slice(0, 8); },           // which reports go into one update
  async grow({ step, files, reports, records, rejections, history, praise, complete }) {
    const res = await complete({ system: '...', messages: [{ role: 'user', content: '...' }] });
    return { summary, rationale, changes: [{ op: 'write', path: 'rules/x.md', content }], addresses: [reportId], skipped: [] };
  },
};
```

A weights recipe sets `surface: 'weights'`, `train: 'sft' | 'pg'`, and returns training examples from `examples(reports, { scenario })` instead of `grow`.

## State

Everything lives under `--state` (default `.atoll/`), one directory per scenario: `records.jsonl`, `reports.jsonl`, `candidates/*.json`, `promotions.json`, `blobs/` (adapters, content-addressed), `retention.json`, `tune.jsonl`, and `artifact/` — an ordinary git repository with a `step-N` tag per version, which you can inspect with `git log`. Weight steps commit a small manifest pointing at a blob, so the history stays light.

## Limits

- **The harness judge is a model, and by default the same model that wrote the change.** It catches vague and mis-scoped changes but is not a proof. Use `--judge-model`, `--evaluator-cmd`, or `--selection manual` when that matters.
- **Weight training here is small-scale.** The MLX runtime trains LoRA adapters on models that fit in memory next to their optimizer state; on 8 GB that means sub-2B models. Bigger models belong on a GPU worker behind `--runtime remote`. atoll ships the protocol and a conformance check for such workers, not a PyTorch implementation.
- **Evaluation is only as good as its tasks.** Without an eval set or verifier, atoll judges by likelihood, which rewards learning what you reported and penalizes forgetting, but cannot tell whether answers to new questions got better.
- **Discovery runs model-written code.** See the sandbox note above. A small local model is a weak proposer; the loop is model-agnostic, so use a strong one when the problem is hard.
- **Implicit corrections are a narrow heuristic** on the start of a prompt. They only open a report; they never change anything on their own.
- **The `claude` backend starts one CLI process per call** (seconds, not milliseconds). That is fine for growing and judging; for serving heavy traffic, use an API upstream or a runtime.
- The demos' `mock` model is deterministic and only proves the plumbing.

```bash
npm test   # node:test, no dependencies; the MLX runtime is exercised by `atoll runtime check`
```

MIT
