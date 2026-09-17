# atoll runtime protocol, version 1

A runtime serves one base model with LoRA adapters and trains new adapters on
request. atoll talks to it over HTTP with JSON bodies. `runtime/mlx/worker.py`
implements it on Apple Silicon. Any other engine — PyTorch + PEFT on a GPU box,
say — plugs in by implementing the same seven endpoints and running with
`atoll serve --runtime remote --runtime-url <url>`.

Check an implementation with:

```bash
atoll runtime check --runtime-url http://gpu-box:9000 --runtime-token $TOKEN
```

## Conventions

- Every request carries `Authorization: Bearer <token>`; anything else is `401`.
- Errors are `{"error": "<message>"}` with a 4xx/5xx status.
- An **adapter** is a named set of LoRA parameters held in memory. `"base"`
  (or `null`) means no adapter. Names match `^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$`.
- All adapters on one runtime share its LoRA layout (rank, layers). An adapter
  file from a runtime with a different model or layout is refused with `409`.
- Messages are `{"role": "user"|"assistant", "content": string}`; the system
  prompt travels separately as `system`.
- Serving must not stop while a training job runs, and must never observe a
  partially trained adapter: generation uses the parameters of the adapter it
  names, as they were when that adapter was last completed or uploaded.

## Endpoints

### `GET /v1/health`

```json
{"ok": true, "protocol": 1, "engine": "mlx", "model": "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
 "lora": {"rank": 8, "layers": 16, "scale": 20.0}, "adapters": ["web@3f2a…"], "jobs": {}}
```

### `POST /v1/generate`

Request: `{"adapter": "name"|null, "system": "...", "messages": [...], "max_tokens": 512, "temperature": 0.7, "top_p": 0}`

Response: `{"text": "...", "adapter": "name"|"base", "finish_reason": "stop"|"length", "usage": {"input": 35, "output": 7}}`

### `POST /v1/score`

Mean negative log-likelihood of each response given its prompt, under an adapter.

Request: `{"adapter": "name"|null, "examples": [{"system": "...", "messages": [...], "response": "..."}]}`

Response: `{"adapter": "...", "nll": [0.41, 2.03, null]}` — `null` when an example does not fit.

### `POST /v1/train` → `202`

Starts a job that produces a new adapter. The runtime keeps serving while it runs.

```json
{"adapter": "web.cand_0mu4…", "kind": "sft"|"pg", "start_from": "name"|null,
 "examples": [{"system": "...", "messages": [...], "response": "...", "weight": 1.0, "advantage": 0.8}],
 "hyper": {"lr": 1e-5, "steps": 16, "epochs": 2, "batch_size": 4, "kl_beta": 0.05, "clip_grad_norm": 1.0}}
```

- `sft` minimizes the weighted negative log-likelihood of `response` (weight defaults to 1).
- `pg` is a policy-gradient step: it minimizes `−advantage · mean log p(response)`
  plus `kl_beta ·` a KL estimate to the base model. Every example needs `advantage`.

Response: a job view (below).

### `GET /v1/train/{job}`

```json
{"id": "4b245c773cde", "adapter": "web.cand_0mu4…", "kind": "sft", "status": "running"|"done"|"failed",
 "step": 5, "total": 16, "loss": 0.82, "losses": [3.03, 1.11, …], "error": null, "seconds": 3.7}
```

When `status` is `done`, the adapter is loaded under its name.

### `GET /v1/adapters/{name}/file`

The adapter as `application/octet-stream` (safetensors for the MLX worker).
The bytes must round-trip through `PUT` on a runtime with the same layout.

### `PUT /v1/adapters/{name}`

Body: adapter bytes. Loads (or replaces) the adapter under `name`.
Response: `{"adapter": "name", "tensors": 112}`.

### `DELETE /v1/adapters/{name}`

Unloads it. Response: `{"deleted": "name"}`.

## Starting a local worker

atoll spawns local workers itself. A worker started by hand must print, once it
is serving, a single stdout line:

```
ATOLL_WORKER_READY {"protocol": 1, "port": 51234, "model": "...", "lora": {...}}
```
