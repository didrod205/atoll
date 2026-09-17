#!/usr/bin/env python3
"""atoll runtime worker — MLX engine.

Holds one base model with LoRA layers and many adapters (parameter sets) in
memory. MLX runs on one dedicated thread; generation requests and individual
training steps queue on it and swap adapter parameters in between, so serving
never pauses for a whole training job and never sees half-trained weights. Speaks the atoll runtime protocol
(runtime/PROTOCOL.md): JSON over HTTP, bearer token, localhost by default.

    python worker.py --model mlx-community/Qwen2.5-0.5B-Instruct-4bit --token T --port 0

Prints one line `ATOLL_WORKER_READY {...}` on stdout once it is serving.
"""

import argparse
import json
import math
import os
import queue
import random
import re
import sys
import tempfile
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

PROTOCOL = 1
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$")


def log(*args):
    # One write per message: the parent reads stderr in chunks and keys on this prefix.
    text = " ".join(str(a) for a in args).rstrip("\n").replace("\n", "\n[atoll-mlx] ")
    sys.stderr.write(f"[atoll-mlx] {text}\n")
    sys.stderr.flush()


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class MlxThread:
    """MLX streams belong to the thread that created them: run every MLX call here, in order."""

    def __init__(self):
        self.tasks = queue.Queue()
        threading.Thread(target=self._loop, daemon=True, name="mlx").start()

    def _loop(self):
        while True:
            fn, box, done = self.tasks.get()
            try:
                box["result"] = fn()
            except BaseException as e:  # handed back to the caller's thread
                box["error"] = e
            done.set()

    def run(self, fn):
        box, done = {}, threading.Event()
        self.tasks.put((fn, box, done))
        done.wait()
        if "error" in box:
            raise box["error"]
        return box["result"]


class Job:
    def __init__(self, name, kind, total):
        self.id = uuid.uuid4().hex[:12]
        self.name = name
        self.kind = kind
        self.total = total
        self.step = 0
        self.loss = None
        self.losses = []
        self.status = "running"
        self.error = None
        self.started = time.time()
        self.finished = None
        self.params = None
        self.tag = f"job:{self.id}"

    def view(self):
        return {
            "id": self.id,
            "adapter": self.name,
            "kind": self.kind,
            "status": self.status,
            "step": self.step,
            "total": self.total,
            "loss": self.loss,
            "losses": self.losses[-200:],
            "error": self.error,
            "seconds": round((self.finished or time.time()) - self.started, 2),
        }


class Engine:
    def __init__(self, mlx_thread, model_id, rank, layers, scale, max_seq):
        self.x = mlx_thread
        self.x.run(lambda: self._init(model_id, rank, layers, scale, max_seq))

    def _init(self, model_id, rank, layers, scale, max_seq):
        import mlx.core as mx
        import mlx.nn as nn
        from mlx.utils import tree_flatten
        from mlx_lm import load
        from mlx_lm.tuner.utils import linear_to_lora_layers

        self.mx, self.nn = mx, nn
        self.model_id = model_id
        started = time.time()
        self.model, self.tokenizer = load(model_id)
        self.model.freeze()
        linear_to_lora_layers(self.model, layers, {"rank": rank, "scale": scale, "dropout": 0.0})
        self.lora = {"rank": rank, "layers": layers, "scale": scale}
        # LoRA's B matrices start at zero, so the fresh parameter set is the base model.
        self.base = dict(tree_flatten(self.model.trainable_parameters()))
        self.shapes = {k: tuple(v.shape) for k, v in self.base.items()}
        self.adapters = {}
        self.active = "base"
        self.max_seq = max_seq
        self.jobs = {}
        log(f"loaded {model_id} in {time.time() - started:.1f}s; {len(self.base)} LoRA tensors, rank {rank}, {layers} layers")

    # --- parameters -----------------------------------------------------------

    def _use(self, params, tag):
        from mlx.utils import tree_unflatten

        if self.active != tag:
            self.model.update(tree_unflatten(list(params.items())))
            self.active = tag

    def _use_adapter(self, name):
        if not name or name == "base":
            self._use(self.base, "base")
            return "base"
        entry = self.adapters.get(name)
        if entry is None:
            raise HttpError(404, f"adapter {name!r} is not loaded")
        self._use(entry["params"], f"adapter:{name}")
        return name

    def metadata(self, name, extra=None):
        meta = {"protocol": PROTOCOL, "engine": "mlx", "model": self.model_id, **self.lora, "adapter": name}
        meta.update(extra or {})
        return meta

    # --- text -----------------------------------------------------------------

    def prompt_text(self, system, messages):
        msgs = ([{"role": "system", "content": system}] if system else []) + [
            {"role": m["role"], "content": m["content"]} for m in messages if m.get("role") in ("user", "assistant")
        ]
        if not msgs or msgs[-1]["role"] != "user":
            raise HttpError(400, "messages must end with a user message")
        return self.tokenizer.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False)

    def example_ids(self, ex):
        prompt = self.tokenizer.encode(self.prompt_text(ex.get("system"), ex["messages"]), add_special_tokens=False)
        response = self.tokenizer.encode(ex["response"], add_special_tokens=False) + [self.tokenizer.eos_token_id]
        room = self.max_seq - len(prompt)
        if room < 8:
            return None
        return prompt + response[:room], len(prompt)

    def batch(self, items):
        mx = self.mx
        width = max(len(ids) for ids, _ in items)
        pad = self.tokenizer.pad_token_id if self.tokenizer.pad_token_id is not None else 0
        x = mx.array([ids + [pad] * (width - len(ids)) for ids, _ in items])
        starts = mx.array([[plen - 1] for _, plen in items])
        ends = mx.array([[len(ids) - 1] for ids, _ in items])
        return x, starts, ends

    def token_logprobs(self, x, starts, ends):
        mx, nn = self.mx, self.nn
        logits = self.model(x[:, :-1]).astype(mx.float32)
        targets = x[:, 1:]
        logp = -nn.losses.cross_entropy(logits, targets, reduction="none")
        steps = mx.arange(targets.shape[1])[None, :]
        mask = mx.logical_and(steps >= starts, steps < ends).astype(mx.float32)
        return logp, mask

    # --- protocol operations ----------------------------------------------------

    def generate(self, body):
        from mlx_lm import stream_generate
        from mlx_lm.sample_utils import make_sampler

        max_tokens = int(body.get("max_tokens") or 512)
        temperature = float(body.get("temperature") if body.get("temperature") is not None else 0.7)
        top_p = float(body.get("top_p") or 0.0)
        prompt = self.prompt_text(body.get("system"), body.get("messages") or [])

        def run():
            used = self._use_adapter(body.get("adapter"))
            text, last = "", None
            for r in stream_generate(self.model, self.tokenizer, prompt, max_tokens=max_tokens, sampler=make_sampler(temp=temperature, top_p=top_p)):
                text += r.text
                last = r
            return used, text, last

        used, text, last = self.x.run(run)
        return {
            "text": text,
            "adapter": used,
            "finish_reason": getattr(last, "finish_reason", None) or "stop",
            "usage": {"input": getattr(last, "prompt_tokens", 0), "output": getattr(last, "generation_tokens", 0)},
        }

    def score(self, body):
        mx = self.mx
        examples = body.get("examples") or []
        if not isinstance(examples, list) or len(examples) > 1000:
            raise HttpError(400, "examples must be a list of at most 1000")
        items = [self.example_ids(ex) for ex in examples]

        def run():
            used = self._use_adapter(body.get("adapter"))
            out = []
            for item in items:
                if item is None:
                    out.append(None)
                    continue
                logp, mask = self.token_logprobs(*self.batch([item]))
                nll = -(logp * mask).sum() / mask.sum()
                mx.eval(nll)
                out.append(round(nll.item(), 6))
            return used, out

        used, out = self.x.run(run)
        return {"adapter": used, "nll": out}

    def train(self, body):
        name = body.get("adapter")
        if not isinstance(name, str) or not NAME.match(name):
            raise HttpError(400, "adapter must be a name of letters, digits and _ . @ : -")
        kind = body.get("kind")
        if kind not in ("sft", "pg"):
            raise HttpError(400, 'kind must be "sft" (imitate) or "pg" (reinforce)')
        start = body.get("start_from")
        if start and start != "base" and start not in self.adapters:
            raise HttpError(404, f"start_from adapter {start!r} is not loaded")
        examples = body.get("examples") or []
        if not isinstance(examples, list) or not examples or len(examples) > 5000:
            raise HttpError(400, "examples must be a non-empty list of at most 5000")
        for ex in examples:
            if not isinstance(ex.get("response"), str) or not isinstance(ex.get("messages"), list):
                raise HttpError(400, "every example needs messages[] and response")
            if kind == "pg" and not isinstance(ex.get("advantage"), (int, float)):
                raise HttpError(400, "pg examples need a numeric advantage")
        h = body.get("hyper") or {}
        batch_size = max(1, int(h.get("batch_size", 4)))
        epochs = float(h.get("epochs", 2))
        steps = int(h.get("steps") or max(8, math.ceil(epochs * len(examples) / batch_size)))
        steps = min(steps, 2000)
        job = Job(name, kind, steps)
        self.jobs[job.id] = job
        threading.Thread(target=self._run, args=(job, start, examples, h, batch_size), daemon=True).start()
        return job.view()

    def _run(self, job, start, examples, h, batch_size):
        mx, nn = self.mx, self.nn
        import mlx.optimizers as optim
        from mlx.utils import tree_flatten

        try:
            items = []
            for ex in examples:
                ids = self.example_ids(ex)
                if ids is not None:
                    items.append((ids, ex))
            if not items:
                raise ValueError("no example fits in max_seq")
            lr = float(h.get("lr", 1e-5))  # higher rates memorize small feedback sets instead of generalizing
            beta = float(h.get("kl_beta", 0.05))
            clip = float(h.get("clip_grad_norm", 1.0))
            # Near-zero loss makes Adam's normalized steps blow up; stop once the examples are learned.
            stop_below = float(h.get("stop_below_loss", 0.05 if job.kind == "sft" else float("-inf")))
            job.params = dict(self.adapters[start]["params"]) if start and start != "base" else dict(self.base)
            opt = self.x.run(lambda: optim.Adam(learning_rate=lr))
            rng = random.Random(int(h.get("seed", 0)))

            def sft_loss(model, x, starts, ends, weights):
                logp, mask = self.token_logprobs(x, starts, ends)
                per = (logp * mask).sum(axis=1)
                count = mask.sum(axis=1)
                return -(per * weights).sum() / (count * weights).sum()

            def pg_loss(model, x, starts, ends, adv, ref):
                logp, mask = self.token_logprobs(x, starts, ends)
                count = mask.sum(axis=1)
                mean_lp = (logp * mask).sum(axis=1) / count
                pg = -(adv * mean_lp).mean()
                # Clipped log-ratio: once the policy drifts far, exp(d) overflows and the loss goes NaN.
                d = mx.clip(ref - logp, -10.0, 10.0)
                kl = (((mx.exp(d) - d - 1) * mask).sum(axis=1) / count).mean()
                return pg + beta * kl

            grad_fn = self.x.run(lambda: nn.value_and_grad(self.model, sft_loss if job.kind == "sft" else pg_loss))
            order = []
            for step in range(job.total):
                if not order:
                    order = list(range(len(items)))
                    rng.shuffle(order)
                picked = [items[order.pop()] for _ in range(min(batch_size, len(order)))]

                def train_step():
                    x, starts, ends = self.batch([ids for ids, _ in picked])
                    if job.kind == "sft":
                        weights = mx.array([float(ex.get("weight", 1.0)) for _, ex in picked])
                        self._use(job.params, job.tag)
                        loss, grads = grad_fn(self.model, x, starts, ends, weights)
                    else:
                        adv = mx.array([float(ex["advantage"]) for _, ex in picked])
                        self._use(self.base, "base")
                        ref, _ = self.token_logprobs(x, starts, ends)
                        ref = mx.stop_gradient(ref)
                        mx.eval(ref)
                        self._use(job.params, job.tag)
                        loss, grads = grad_fn(self.model, x, starts, ends, adv, ref)
                    if clip > 0:
                        grads, _ = optim.clip_grad_norm(grads, clip)
                    opt.update(self.model, grads)
                    mx.eval(self.model.trainable_parameters(), opt.state, loss)
                    job.params = dict(tree_flatten(self.model.trainable_parameters()))
                    return loss.item()

                # One queued task per step: generation requests interleave between steps.
                loss = self.x.run(train_step)
                job.step = step + 1
                job.loss = round(loss, 6)
                job.losses.append(job.loss)
                if not math.isfinite(job.loss):
                    raise ValueError(f"loss became {job.loss} at step {job.step}; lower the learning rate")
                window = job.losses[-min(3, len(items)):]
                if len(window) >= min(3, len(items)) and sum(window) / len(window) < stop_below:
                    job.total = job.step  # converged
                    break
            self.adapters[job.name] = {
                "params": job.params,
                "meta": self.metadata(job.name, {"kind": job.kind, "steps": job.total, "examples": len(items), "final_loss": job.loss}),
            }
            job.status = "done"
            log(f"trained {job.name}: {job.kind}, {job.total} steps, {len(items)} examples, loss {job.loss}")
        except Exception as e:  # reported through the job, the worker keeps serving
            job.status = "failed"
            job.error = f"{type(e).__name__}: {e}"
            log(traceback.format_exc())
        finally:
            job.finished = time.time()
            job.params = None  # the adapter entry holds the trained parameters

    def export(self, name):
        entry = self.adapters.get(name)
        if entry is None:
            raise HttpError(404, f"adapter {name!r} is not loaded")
        fd, path = tempfile.mkstemp(suffix=".safetensors")
        os.close(fd)
        try:
            self.x.run(lambda: self.mx.save_safetensors(path, entry["params"], metadata={"atoll": json.dumps(entry["meta"])}))
            with open(path, "rb") as f:
                return f.read()
        finally:
            os.unlink(path)

    def import_(self, name, data):
        if not NAME.match(name):
            raise HttpError(400, "invalid adapter name")
        fd, path = tempfile.mkstemp(suffix=".safetensors")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        try:
            arrays, metadata = self.x.run(lambda: self.mx.load(path, return_metadata=True))
        except Exception as e:
            raise HttpError(400, f"not a safetensors adapter: {e}")
        finally:
            os.unlink(path)
        meta = json.loads(metadata.get("atoll", "{}"))
        if meta and (meta.get("model") != self.model_id or any(meta.get(k) != v for k, v in self.lora.items())):
            raise HttpError(409, f"adapter was trained for {meta.get('model')} rank {meta.get('rank')} layers {meta.get('layers')}; this worker runs {self.model_id} rank {self.lora['rank']} layers {self.lora['layers']}")
        if set(arrays) != set(self.shapes) or any(tuple(arrays[k].shape) != self.shapes[k] for k in arrays):
            raise HttpError(409, "adapter tensors do not match this worker's LoRA layout")
        def store():
            self.adapters[name] = {"params": arrays, "meta": {**meta, "adapter": name}}
            if self.active == f"adapter:{name}":
                self.active = None

        self.x.run(store)
        return {"adapter": name, "tensors": len(arrays)}

    def delete(self, name):
        def drop():
            if self.adapters.pop(name, None) is None:
                raise HttpError(404, f"adapter {name!r} is not loaded")
            if self.active == f"adapter:{name}":
                self.active = None

        self.x.run(drop)
        return {"deleted": name}

    def health(self):
        return {
            "ok": True,
            "protocol": PROTOCOL,
            "engine": "mlx",
            "model": self.model_id,
            "lora": self.lora,
            "max_seq": self.max_seq,
            "adapters": sorted(self.adapters),
            "jobs": {j.id: j.status for j in self.jobs.values() if j.status == "running"},
            "peak_memory_gb": round(self.mx.get_peak_memory() / 1e9, 3),
        }


def make_handler(engine, token):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _send(self, status, payload, content_type="application/json"):
            body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get("content-length") or 0)
            if n > 512 * 1024 * 1024:
                raise HttpError(413, "body too large")
            return self.rfile.read(n) if n else b""

        def _json(self):
            raw = self._body()
            try:
                return json.loads(raw or b"{}")
            except json.JSONDecodeError:
                raise HttpError(400, "body is not JSON")

        def _dispatch(self, method):
            try:
                if self.headers.get("authorization") != f"Bearer {token}":
                    raise HttpError(401, "invalid worker token")
                path = self.path.split("?")[0]
                m = re.match(r"^/v1/adapters/([^/]+)(/file)?$", path)
                if method == "GET" and path == "/v1/health":
                    return self._send(200, engine.health())
                if method == "POST" and path == "/v1/generate":
                    return self._send(200, engine.generate(self._json()))
                if method == "POST" and path == "/v1/score":
                    return self._send(200, engine.score(self._json()))
                if method == "POST" and path == "/v1/train":
                    return self._send(202, engine.train(self._json()))
                jm = re.match(r"^/v1/train/([0-9a-f]+)$", path)
                if method == "GET" and jm:
                    job = engine.jobs.get(jm.group(1))
                    if not job:
                        raise HttpError(404, "no such job")
                    return self._send(200, job.view())
                name = unquote(m.group(1)) if m else None
                if m and method == "GET" and m.group(2):
                    return self._send(200, engine.export(name), "application/octet-stream")
                if m and method == "PUT" and not m.group(2):
                    return self._send(200, engine.import_(name, self._body()))
                if m and method == "DELETE" and not m.group(2):
                    return self._send(200, engine.delete(name))
                raise HttpError(404, f"no route {method} {path}")
            except HttpError as e:
                self._send(e.status, {"error": str(e)})
            except Exception as e:
                log(traceback.format_exc())
                self._send(500, {"error": f"{type(e).__name__}: {e}"})

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_PUT(self):
            self._dispatch("PUT")

        def do_DELETE(self):
            self._dispatch("DELETE")

    return Handler


def watch_parent(pid):
    while True:
        time.sleep(2)
        if os.getppid() != pid:
            log("parent process exited; stopping")
            os._exit(0)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--model", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--token", default=os.environ.get("ATOLL_WORKER_TOKEN", ""))
    ap.add_argument("--lora-rank", type=int, default=8)
    ap.add_argument("--lora-layers", type=int, default=16)
    ap.add_argument("--lora-scale", type=float, default=20.0)
    ap.add_argument("--max-seq", type=int, default=1024)
    ap.add_argument("--parent-pid", type=int, default=0)
    args = ap.parse_args()
    if not args.token:
        ap.error("--token (or ATOLL_WORKER_TOKEN) is required")
    engine = Engine(MlxThread(), args.model, args.lora_rank, args.lora_layers, args.lora_scale, args.max_seq)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(engine, args.token))
    if args.parent_pid:
        threading.Thread(target=watch_parent, args=(args.parent_pid,), daemon=True).start()
    ready = {"protocol": PROTOCOL, "engine": "mlx", "host": args.host, "port": server.server_address[1], "model": args.model, "lora": engine.lora}
    print("ATOLL_WORKER_READY " + json.dumps(ready), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
