// Upstream model backends. Each exposes:
//   native            'openai' | 'anthropic' | null — format it can take raw
//   model             default model id
//   complete(canon)   -> canonical response
//   forward(body)     -> fetch Response (only when native is set)

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError, kebab, sha256 } from './util.js';
import {
  parseAnthropicResponse,
  parseOpenAIResponse,
  toAnthropicRequest,
  toOpenAIRequest,
} from './translate.js';

export const UPSTREAMS = ['claude', 'anthropic', 'openai', 'mock'];

export function createProvider(cfg) {
  switch (cfg.upstream) {
    case 'claude':
      return claudeCli(cfg);
    case 'anthropic':
      return anthropicApi(cfg);
    case 'openai':
      return openaiCompatible(cfg);
    case 'mock':
      return mock(cfg);
    default:
      throw new Error(`unknown upstream "${cfg.upstream}" (expected one of ${UPSTREAMS.join(', ')})`);
  }
}

async function upstreamError(res) {
  const body = await res.text().catch(() => '');
  return new HttpError(502, `upstream returned ${res.status}: ${body.slice(0, 500)}`);
}

function joinUrl(base, path) {
  const b = base.replace(/\/+$/, '');
  return b.endsWith('/v1') ? `${b}${path.replace(/^\/v1/, '')}` : `${b}${path}`;
}

// --- Anthropic Messages API ------------------------------------------------

function anthropicApi(cfg) {
  const url = cfg.upstreamUrl || 'https://api.anthropic.com';
  const headers = () => {
    if (!cfg.upstreamApiKey) throw new HttpError(500, 'ATOLL_UPSTREAM_API_KEY is not set');
    return { 'content-type': 'application/json', 'x-api-key': cfg.upstreamApiKey, 'anthropic-version': '2023-06-01' };
  };
  return {
    name: 'anthropic',
    native: 'anthropic',
    model: cfg.upstreamModel || 'claude-sonnet-5',
    forward(body, { signal } = {}) {
      return fetch(joinUrl(url, '/v1/messages'), { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
    },
    async complete(c, { model, signal } = {}) {
      const res = await this.forward(toAnthropicRequest(c, model || this.model), { signal });
      if (!res.ok) throw await upstreamError(res);
      return parseAnthropicResponse(await res.json());
    },
  };
}

// --- OpenAI-compatible (OpenAI, Ollama, vLLM, SGLang, OpenRouter, ...) ------

function openaiCompatible(cfg) {
  const url = cfg.upstreamUrl || 'http://127.0.0.1:11434';
  const headers = () => ({
    'content-type': 'application/json',
    ...(cfg.upstreamApiKey ? { authorization: `Bearer ${cfg.upstreamApiKey}` } : {}),
  });
  return {
    name: 'openai',
    native: 'openai',
    model: cfg.upstreamModel,
    forward(body, { signal } = {}) {
      return fetch(joinUrl(url, '/v1/chat/completions'), { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
    },
    async complete(c, { model, signal } = {}) {
      const m = model || this.model;
      if (!m) throw new HttpError(500, '--upstream-model is required for the openai upstream');
      const res = await this.forward(toOpenAIRequest(c, m), { signal });
      if (!res.ok) throw await upstreamError(res);
      return parseOpenAIResponse(await res.json());
    },
  };
}

// --- Claude Code CLI (your existing Claude login, no API key) ---------------

// Variables a parent Claude Code session sets for its own children. Passing
// them on makes the nested CLI think it is a subagent of that session.
const PARENT_SESSION_ENV = /^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|HOST_SESSION_ID|MESSAGING_\w+|SDK_\w+|EXECPATH|OAUTH_SCOPES)|CLAUDE_AGENT_SDK_VERSION|CLAUDE_PID)$/;

export function renderTranscript(messages) {
  if (messages.length === 1 && messages[0].role === 'user') return messages[0].content;
  const turns = messages.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`).join('\n');
  return `${turns}\n\nContinue the conversation: write only the assistant's next reply.`;
}

function claudeCli(cfg) {
  const bin = cfg.claudeBin || 'claude';
  const cwd = join(tmpdir(), 'atoll-claude-cwd');
  mkdirSync(cwd, { recursive: true });
  return {
    name: 'claude',
    native: null,
    model: cfg.upstreamModel || null,
    complete(c, { model, signal } = {}) {
      const m = model || this.model;
      const args = [
        '-p',
        '--output-format', 'json',
        '--tools', '',
        '--no-session-persistence',
        '--system-prompt', c.system || 'You are a helpful assistant. Answer directly.',
      ];
      if (m) args.push('--model', m);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !PARENT_SESSION_ENV.test(k)));
      env.ATOLL_RECORD = '0'; // never record atoll's own model calls through an installed hook
      return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], signal });
        let out = '';
        let err = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), cfg.timeoutMs ?? 600_000);
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(new HttpError(502, e.code === 'ENOENT' ? `"${bin}" not found on PATH — install Claude Code or choose another --upstream` : `claude CLI: ${e.message}`));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          let json;
          try {
            json = JSON.parse(out);
          } catch {
            return reject(new HttpError(502, `claude CLI exited ${code}: ${(err || out).slice(0, 500)}`));
          }
          if (json.is_error || json.subtype !== 'success') {
            const hint = /authenticat|login|oauth/i.test(json.result ?? '') ? ' — run `claude` and /login in a terminal' : '';
            return reject(new HttpError(502, `claude CLI: ${json.result ?? json.subtype}${hint}`));
          }
          const u = json.usage ?? {};
          resolve({
            text: json.result ?? '',
            model: m || Object.keys(json.modelUsage ?? {})[0] || 'claude',
            stopReason: json.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
            usage: {
              input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              output: u.output_tokens ?? 0,
            },
          });
        });
        child.stdin.end(renderTranscript(c.messages));
      });
    },
  };
}

// --- Mock: deterministic, offline. Drives `atoll demo` and the tests. -------

function mock(cfg) {
  return {
    name: 'mock',
    native: null,
    model: cfg.upstreamModel || 'mock-1',
    async complete(c) {
      const last = [...c.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      let text;
      if (c.system.includes('ATOLL:GROW')) text = JSON.stringify(mockGrow(last));
      else if (c.system.includes('ATOLL:EVOLVE')) text = mockEvolve(last);
      else if (c.system.includes('ATOLL:JUDGE')) text = JSON.stringify(mockJudge(last));
      else {
        const exact = last.match(/return exactly:\s*(.+)$/im);
        text = exact ? exact[1].trim() : `mock reply to: ${last.slice(0, 200)}`;
      }
      return { text, model: this.model, stopReason: 'end', usage: { input: Math.ceil(last.length / 4), output: Math.ceil(text.length / 4) } };
    },
  };
}

const FEEDBACK_BLOCK = /<feedback id="([^"]+)" kind="([^"]+)"[^>]*>\n([\s\S]*?)\n(?:<interaction|<previous_attempt|<\/feedback>)/g;

function mockGrow(prompt) {
  const changes = [];
  const addresses = [];
  const skipped = [];
  const toAddress = prompt.split('<working_well')[0];
  for (const [, id, kind, body] of toAddress.matchAll(FEEDBACK_BLOCK)) {
    const text = body.trim();
    if (kind === 'implicit') {
      skipped.push({ id, why: 'mock model: implicit corrections need a real model to generalize' });
      continue;
    }
    if (text.includes('[mock:bad-path]')) {
      changes.push({ op: 'write', path: '../outside.md', content: text });
      addresses.push(id);
      continue;
    }
    const STOP = /\b(when|i|ask|you|to|a|an|the|for|every|and|or|of|it|with|first|please|always|never)\b/gi;
    const slug = kebab(text.replace(/\[mock:[^\]]+\]/g, '').replace(STOP, ' '), 4);
    const name = slug === 'item' ? `item-${sha256(text).slice(0, 6)}` : slug; // non-English asks
    if (/^when\b/i.test(text)) {
      changes.push({
        op: 'write',
        path: `skills/${name}/SKILL.md`,
        content: `---\nname: ${name}\ndescription: ${text.replace(/\n/g, ' ').slice(0, 300)}\n---\n\n# ${text.split('\n')[0]}\n\n1. Follow the request above every time it applies.\n`,
      });
    } else {
      changes.push({ op: 'write', path: `rules/${name}.md`, content: `- ${text.replace(/\n+/g, ' ')}\n` });
    }
    addresses.push(id);
  }
  return {
    summary: changes.length ? `mock: encode ${addresses.length} feedback item(s)` : 'mock: nothing to change',
    rationale: 'Deterministic mock recipe output — asks starting with "when" become skills, everything else a rule.',
    changes,
    addresses,
    skipped,
  };
}

function mockJudge(prompt) {
  const section = prompt.split('<earlier_feedback>')[0];
  const verdicts = [...section.matchAll(FEEDBACK_BLOCK)].map(([, id, , body]) => ({
    id,
    addressed: !body.includes('[mock:judge-fail]'),
    why: body.includes('[mock:judge-fail]') ? 'mock judge told to fail' : 'mock judge: change names the requested behavior',
  }));
  return { verdicts, regressions: [], score: verdicts.every((v) => v.addressed) ? 0.9 : 0.2, notes: 'mock judge' };
}

// Discovery: nudge one numeric constant of the best attempt. A real model does
// far better; this is a deterministic local search that exercises the loop.
function mockEvolve(prompt) {
  const block = prompt.match(/```([\w+-]*)\n([\s\S]*?)```/);
  if (!block) return 'IDEA: mock: nothing to start from\n(no code)';
  const [, lang, code] = block;
  const attempts = Number(prompt.match(/Attempts so far: (\d+)/)?.[1] ?? 0);
  const numbers = [...code.matchAll(/(?<![\w.])\d+\.\d+(?![\w.])/g)];
  if (!numbers.length) return `IDEA: mock: no numeric constants to vary\n\`\`\`${lang}\n${code}\`\`\``;
  const pick = (attempts * 7919 + 13) % numbers.length;
  const factors = [1.1, 0.9, 1.03, 0.97, 1.01, 0.99];
  const factor = factors[(attempts * 31 + pick) % factors.length];
  const m = numbers[pick];
  const next = String(Number((Number(m[0]) * factor).toFixed(6)));
  const mutated = code.slice(0, m.index) + next + code.slice(m.index + m[0].length);
  return `IDEA: mock: constant #${pick} ${m[0]} → ${next}\n\`\`\`${lang}\n${mutated}\`\`\``;
}
