import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const VERSION = '0.1.0';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Time-sortable id: prefix, base36 millis, 10 hex chars of entropy. */
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36).padStart(9, '0')}${randomBytes(5).toString('hex')}`;
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export const now = () => new Date().toISOString();

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function truncate(s, max) {
  if (typeof s !== 'string') return s;
  return s.length <= max ? s : `${s.slice(0, max)}… [${s.length - max} chars truncated]`;
}

export function kebab(s, maxWords = 6) {
  const words = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, maxWords);
  return words.join('-').slice(0, 60) || 'item';
}

/**
 * Pull one JSON object out of model output: the whole text, a fenced block,
 * or the first balanced {...} span. Throws when none parses.
 */
export function extractJson(text) {
  const t = String(text ?? '').trim();
  const attempts = [t];
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) attempts.push(fence[1]);
  const span = firstBalancedObject(t);
  if (span) attempts.push(span);
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {}
  }
  throw new Error(`no JSON object in model output: ${truncate(t, 200)}`);
}

function firstBalancedObject(t) {
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return t.slice(start, i + 1);
  }
  return null;
}

/** A promise chain per key, so jobs and user actions on one scenario never interleave. */
export class Mutex {
  #tail = Promise.resolve();
  run(fn) {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.catch(() => {});
    return result;
  }
}

/** Line diff (LCS) rendered as unified hunks. Small inputs only — harness files. */
export function unifiedDiff(oldText, newText, { path = 'file', context = 3 } = {}) {
  const lines = (t) => (t == null || t === '' ? [] : t.replace(/\n$/, '').split('\n'));
  const a = lines(oldText);
  const b = lines(newText);
  const header = `--- ${oldText == null ? '/dev/null' : `a/${path}`}\n+++ ${newText == null ? '/dev/null' : `b/${path}`}\n`;
  if (a.length * b.length > 4_000_000) {
    return `${header}@@ file too large to diff @@\n`;
  }
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push([' ', a[i++], j++]);
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  const changed = ops.flatMap((o, idx) => (o[0] === ' ' ? [] : [idx]));
  if (!changed.length) return '';
  const groups = [[changed[0], changed[0]]];
  for (const idx of changed.slice(1)) {
    const g = groups[groups.length - 1];
    if (idx - g[1] - 1 <= context * 2) g[1] = idx;
    else groups.push([idx, idx]);
  }
  let out = header;
  for (const [first, last] of groups) {
    const start = Math.max(0, first - context);
    const end = Math.min(ops.length, last + context + 1);
    const hunk = ops.slice(start, end);
    const oldLen = hunk.filter((o) => o[0] !== '+').length;
    const newLen = hunk.filter((o) => o[0] !== '-').length;
    const oldStart = ops.slice(0, start).filter((o) => o[0] !== '+').length + (oldLen ? 1 : 0);
    const newStart = ops.slice(0, start).filter((o) => o[0] !== '-').length + (newLen ? 1 : 0);
    out += `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@\n`;
    for (const [op, text] of hunk) out += `${op}${text}\n`;
  }
  return out;
}
