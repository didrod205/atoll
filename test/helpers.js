import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';

export function tempDir(prefix = 'atoll-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function startServer(t, options = {}) {
  const dir = tempDir();
  const app = await createServer({
    upstream: 'mock',
    port: 0,
    state: join(dir, 'state'),
    debounceMs: 60_000, // tests drive grow explicitly unless they opt in
    log: () => {},
    ...options,
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = async (method, path, body, { scenario = 'test', token = app.cfg.token, headers = {} } = {}) => {
    const res = await fetch(app.url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-atoll-scenario': scenario, 'content-type': 'application/json', ...headers },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, json, text };
  };
  return { app, api, dir };
}

/** A recipe module whose next draft the test sets through globalThis.__atollDraft. */
export function scriptedRecipe(dir) {
  const file = join(dir, 'scripted-recipe.mjs');
  writeFileSync(
    file,
    `export default {
  name: 'scripted',
  triggers: () => false,
  select: (open) => open,
  async grow(ctx) {
    const next = globalThis.__atollDraft;
    return typeof next === 'function' ? next(ctx) : next;
  },
};
`,
  );
  return file;
}
