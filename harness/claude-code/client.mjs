#!/usr/bin/env node
// atoll client for Claude Code. Installed at <project>/.claude/atoll/client.mjs.
// Zero dependencies. Every hook entry point exits 0 and stays quiet on failure:
// a broken or stopped atoll server must never get in the way of a session.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CLIENT = join(HERE, 'client.mjs');
const RULES_START = '<!-- atoll:start -->';
// Hooks go to the personal settings file: settings.json is usually committed,
// and a teammate without atoll would get a failing hook on every session.
const LOCAL_SETTINGS = join('.claude', 'settings.local.json');
const SHARED_SETTINGS = join('.claude', 'settings.json');
const EXCLUDE_START = '# atoll:start — local install, machine-specific paths';
const EXCLUDE_END = '# atoll:end';
const RULES_END = '<!-- atoll:end -->';

const localTime = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const sha = (s) => createHash('sha256').update(s).digest('hex');

// A reinstall drops config.new.json next to us: take its server, token and
// scenario, keep the user's own record/autoUpdate choices.
const incoming = readJson(join(HERE, 'config.new.json'), null);
if (incoming) {
  const previous = readJson(join(HERE, 'config.json'), {});
  writeJson(join(HERE, 'config.json'), {
    ...incoming,
    ...(previous.record != null ? { record: previous.record } : {}),
    ...(previous.autoUpdate != null ? { autoUpdate: previous.autoUpdate } : {}),
  });
  rmSync(join(HERE, 'config.new.json'));
}
const fileCfg = readJson(join(HERE, 'config.json'), {});
const cfg = {
  url: (process.env.ATOLL_URL || fileCfg.url || 'http://127.0.0.1:8901').replace(/\/+$/, ''),
  token: process.env.ATOLL_TOKEN || fileCfg.token || 'atoll-local',
  scenario: process.env.ATOLL_SCENARIO || fileCfg.scenario || 'default',
  record: fileCfg.record !== false,
  autoUpdate: fileCfg.autoUpdate === true,
};

async function api(method, path, body, { timeout = 15_000 } = {}) {
  let res;
  try {
    res = await fetch(cfg.url + path, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, 'x-atoll-scenario': cfg.scenario, 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(`atoll server not reachable at ${cfg.url} (${e.cause?.code ?? e.name}) — start it with: atoll serve`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const details = json?.details ? ` — ${Array.isArray(json.details) ? json.details.join('; ') : JSON.stringify(json.details)}` : '';
    throw new Error(`${json?.error ?? `HTTP ${res.status}`}${details}`);
  }
  return json;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Arguments from argv, or from stdin when a slash command pipes $ARGUMENTS through a heredoc. */
function argText(args) {
  return (args.length ? args.join(' ') : readStdin()).trim();
}

// --- applying a bundle -------------------------------------------------------

function destination(file) {
  const [top, ...rest] = file.path.split('/');
  if (top === 'skills') return join('.claude', 'skills', ...rest);
  if (top === 'commands') return join('.claude', 'commands', ...rest);
  if (top === 'hooks' && !file.path.endsWith('.json')) return join('.claude', 'atoll', 'hooks', ...rest);
  return null;
}

function hookCommand(script) {
  const path = `"$CLAUDE_PROJECT_DIR/.claude/atoll/hooks/${basename(script)}"`;
  if (script.endsWith('.sh')) return `bash ${path}`;
  if (script.endsWith('.py')) return `python3 ${path}`;
  return `node ${path}`;
}

function removeEmptyDirs(start, stop) {
  let dir = start;
  while (dir.startsWith(stop) && dir !== stop) {
    try {
      if (readdirSync(dir).length) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

export function renderRulesBlock(rules, step) {
  if (!rules.length) return null;
  const body = rules
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((r) => r.content.trim())
    .join('\n\n');
  return `${RULES_START}\n## Working rules (atoll step ${step})\n\nLearned from this user's feedback. This block is rewritten by /atoll-update; ask for changes with /atoll-harness instead of editing it.\n\n${body}\n${RULES_END}`;
}

/** Replace (or append, or remove) the managed block; everything the user wrote stays byte-for-byte. */
export function spliceRulesBlock(existing, block) {
  const text = existing ?? '';
  const start = text.indexOf(RULES_START);
  const end = text.indexOf(RULES_END);
  let before = text;
  let after = '';
  if (start >= 0 && end > start) {
    before = text.slice(0, start);
    after = text.slice(end + RULES_END.length);
  } else if (!block) return text;
  const pieces = [before.replace(/\s+$/, ''), block ?? '', after.replace(/^\s+/, '').replace(/\s+$/, '')].filter(Boolean);
  return pieces.length ? `${pieces.join('\n\n')}\n` : '';
}

export function mergeHooks(settings, { own, harness }) {
  const next = structuredClone(settings ?? {});
  next.hooks ??= {};
  const ours = (cmd) => typeof cmd === 'string' && (cmd.includes('.claude/atoll/hooks/') || (own && cmd.includes('.claude/atoll/client.mjs')));
  for (const event of Object.keys(next.hooks)) {
    next.hooks[event] = (next.hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h.command)) }))
      .filter((g) => g.hooks.length);
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  const add = (event, matcher, hook) => {
    next.hooks[event] ??= [];
    next.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [hook] });
  };
  for (const h of own ?? []) add(h.event, h.matcher, { type: 'command', command: h.command, timeout: h.timeout });
  for (const h of harness ?? []) add(h.event, h.matcher, { type: 'command', command: h.command, timeout: h.timeout ?? 60 });
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

export function applyBundle(root, bundle, { force = false } = {}) {
  const appliedFile = join(root, '.claude', 'atoll', 'applied.json');
  const applied = readJson(appliedFile, { step: 0, revision: null, files: {} });
  const planned = new Map();
  const rules = [];
  const hooks = [];
  for (const f of bundle.files) {
    if (f.kind === 'rule') rules.push(f);
    else if (f.kind === 'hook' && f.path.endsWith('.json')) {
      const spec = JSON.parse(f.content);
      hooks.push({ event: spec.event, matcher: spec.matcher, timeout: spec.timeout, command: hookCommand(spec.command) });
    } else {
      const dest = destination(f);
      if (dest) planned.set(dest, f);
    }
  }

  const report = { added: [], updated: [], removed: [], kept: [], unchanged: 0 };
  const files = {};
  for (const [dest, f] of planned) {
    const abs = join(root, dest);
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    const currentSha = current == null ? null : sha(current);
    if (currentSha === f.sha256) {
      files[dest] = f.sha256;
      report.unchanged++;
      continue;
    }
    if (current != null && applied.files[dest] !== currentSha && !force) {
      report.kept.push(`${dest} (edited locally — not overwritten; use --force)`);
      if (applied.files[dest]) files[dest] = applied.files[dest];
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    if (dest.includes(join('.claude', 'atoll', 'hooks'))) chmodSync(abs, 0o755);
    files[dest] = f.sha256;
    (current == null ? report.added : report.updated).push(dest);
  }
  for (const [dest, oldSha] of Object.entries(applied.files ?? {})) {
    if (planned.has(dest)) continue;
    const abs = join(root, dest);
    if (!existsSync(abs)) continue;
    if (sha(readFileSync(abs, 'utf8')) !== oldSha && !force) {
      report.kept.push(`${dest} (removed upstream but edited locally — left in place)`);
      continue;
    }
    rmSync(abs);
    removeEmptyDirs(dirname(abs), join(root, '.claude'));
    report.removed.push(dest);
  }

  const claudeMd = join(root, 'CLAUDE.md');
  const block = renderRulesBlock(rules, bundle.step);
  const before = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : null;
  if (before != null || block) {
    const after = spliceRulesBlock(before, block);
    if (after !== before) {
      if (after) writeFileSync(claudeMd, after);
      else rmSync(claudeMd); // it held nothing but atoll's block
    }
  }

  writeHooks(root, { harness: hooks });

  writeJson(appliedFile, { step: bundle.step, revision: bundle.revision, files, at: new Date().toISOString() });
  return { ...report, step: bundle.step, rules: rules.length, hooks: hooks.length, held: bundle.held ?? [] };
}

function updateJson(file, fn) {
  const before = readJson(file, null);
  const after = fn(before ?? {});
  if (JSON.stringify(after) === JSON.stringify(before ?? {})) return;
  if (Object.keys(after).length) writeJson(file, after);
  else if (before) rmSync(file);
}

/** own: atoll's client hooks (undefined = leave as they are). harness: promoted harness hooks. */
export function writeHooks(root, { own, harness }) {
  updateJson(join(root, LOCAL_SETTINGS), (settings) => mergeHooks(settings, { own, harness }));
  // Entries an older install left in the shared file.
  updateJson(join(root, SHARED_SETTINGS), (settings) => mergeHooks(settings, { own: own && [], harness: [] }));
}

/** Keep atoll's machine-local files out of commits via .git/info/exclude (never the shared .gitignore). */
export function gitExclude(root, add) {
  let excludeFile;
  let prefix;
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude', '--show-prefix'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
    excludeFile = resolve(root, out[0]);
    prefix = out[1] ?? '';
  } catch {
    return false; // not a git repository, or no git
  }
  const text = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  const start = text.indexOf(EXCLUDE_START);
  const end = text.indexOf(EXCLUDE_END);
  const without = start >= 0 && end > start ? text.slice(0, start) + text.slice(end + EXCLUDE_END.length).replace(/^\n/, '') : text;
  const block = [EXCLUDE_START, ...['.claude/atoll/', '.claude/settings.local.json', '.claude/commands/atoll-*.md'].map((p) => `/${prefix}${p}`), EXCLUDE_END].join('\n');
  const next = add ? `${without.replace(/\n*$/, without ? '\n' : '')}${block}\n` : without;
  if (next !== text) {
    mkdirSync(dirname(excludeFile), { recursive: true });
    writeFileSync(excludeFile, next);
  }
  return true;
}

// --- transcript → record -------------------------------------------------------

function tail(file, bytes = 4 * 1024 * 1024) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

function blocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

function toolInput(name, input = {}) {
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  return JSON.stringify(input).slice(0, 200);
}

/** The last real user prompt in a Claude Code transcript and everything the agent did after it. */
export function lastTurn(jsonl) {
  const entries = jsonl
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && !e.isSidechain);
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user' || e.isMeta) continue;
    const c = e.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) continue;
    const text = blocksText(c);
    if (!text.trim() || text.startsWith('<local-command') || text.startsWith('<bash-')) continue;
    start = i;
    break;
  }
  if (start < 0) return null;
  const prompt = blocksText(entries[start].message.content);
  const texts = [];
  const tools = [];
  let model = null;
  for (const e of entries.slice(start + 1)) {
    if (e.type !== 'assistant') continue;
    model = e.message?.model ?? model;
    for (const b of e.message?.content ?? []) {
      if (b?.type === 'text' && b.text.trim()) texts.push(b.text);
      if (b?.type === 'tool_use') tools.push({ name: b.name, input: toolInput(b.name, b.input) });
    }
  }
  return { prompt, response: texts.join('\n\n'), tools, model };
}

// --- commands ------------------------------------------------------------------

const commands = {
  async pull(args) {
    const bundle = await api('GET', '/atoll/harness/bundle');
    const r = applyBundle(ROOT, bundle, { force: args.includes('--force') });
    const lines = [`atoll: harness step ${r.step} installed in ${ROOT}`];
    if (r.added.length) lines.push(`  added    ${r.added.join(', ')}`);
    if (r.updated.length) lines.push(`  updated  ${r.updated.join(', ')}`);
    if (r.removed.length) lines.push(`  removed  ${r.removed.join(', ')}`);
    lines.push(`  rules    ${r.rules} in CLAUDE.md${r.hooks ? `; hooks ${r.hooks} in .claude/settings.local.json` : ''}`);
    for (const k of r.kept) lines.push(`  kept     ${k}`);
    for (const h of r.held) lines.push(`  held     ${h.path} — executable; promote it with /atoll-versions <step> promote`);
    console.log(lines.join('\n'));
  },

  async 'session-start'() {
    readStdin();
    try {
      const applied = readJson(join(HERE, 'applied.json'), { step: 0, revision: null });
      const m = await api('GET', '/atoll/harness/manifest', null, { timeout: 2500 });
      if (m.revision === applied.revision) return;
      if (cfg.autoUpdate) {
        const r = applyBundle(ROOT, await api('GET', '/atoll/harness/bundle', null, { timeout: 5000 }));
        console.log(`atoll: harness updated to step ${r.step} (${r.added.length} added, ${r.updated.length} updated, ${r.removed.length} removed). Rules and skills from this step apply from the next session.`);
        return;
      }
      const c = m.counts;
      const parts = [c.rule && `${c.rule} rule(s)`, c.skill && `${c.skill} skill(s)`, c.command && `${c.command} command(s)`, c.hook && `${c.hook} hook(s)`].filter(Boolean);
      console.log(
        `atoll: a new harness version is available for this project — step ${m.step} (installed: step ${applied.step}; contains ${parts.join(', ') || 'no files'}).` +
          ' At a natural point, tell the user in one line and offer to install it with /atoll-update.' +
          (m.held.length ? ` ${m.held.length} executable file(s) are held until the user promotes them: /atoll-versions <step> promote.` : ''),
      );
    } catch {}
  },

  async record() {
    try {
      const input = JSON.parse(readStdin() || '{}');
      if (process.env.ATOLL_RECORD === '0' || !cfg.record || !input.transcript_path) return;
      const turn = lastTurn(tail(input.transcript_path));
      if (!turn || /<command-name>\/atoll-/.test(turn.prompt)) return;
      const res = await api('POST', '/atoll/records', { ...turn, session: input.session_id, source: 'claude-code' }, { timeout: 3000 });
      writeJson(join(HERE, 'state.json'), { lastReceipt: res.receipt, lastPrompt: turn.prompt.slice(0, 160), at: new Date().toISOString() });
    } catch {}
  },

  async ask(args) {
    const text = argText(args);
    if (!text) throw new Error('usage: ask <what the agent should do differently>');
    const r = await api('POST', '/atoll/harness/ask', { text, source: 'claude-code' });
    console.log(`atoll: filed ${r.id} for scenario "${cfg.scenario}". atoll will write it as a rule, skill, command or hook, check it, and publish it as a new version — the next session offers the install (or run /atoll-versions).`);
  },

  async report(args) {
    const text = argText(args);
    const [first = '', ...rest] = text.split(/\s+/);
    const words = { good: 1, '+': 1, '👍': 1, up: 1, yes: 1, bad: 0, '-': 0, '👎': 0, down: 0, no: 0 };
    let score = words[first.toLowerCase()];
    let feedback = rest.join(' ');
    if (score == null && first !== '' && Number.isFinite(Number(first))) score = Number(first);
    if (score == null) {
      score = undefined;
      feedback = text;
    }
    const state = readJson(join(HERE, 'state.json'), {});
    if (!state.lastReceipt) throw new Error('no recorded turn to report on yet — the Stop hook records each finished turn');
    if (score === undefined && !feedback) throw new Error('usage: report good|bad|<0-1> [what was right or wrong]');
    const r = await api('POST', '/atoll/report', { score, feedback: feedback || undefined, references: [state.lastReceipt], source: 'claude-code' });
    console.log(`atoll: report ${r.id} attached to the turn "${state.lastPrompt}"${score != null ? ` (score ${score})` : ''}.`);
  },

  async versions(args) {
    const words = argText(args).split(/\s+/).filter(Boolean);
    const step = words[0] != null ? Number(words[0]) : null;
    const action = words[1];
    if (words.length && !Number.isInteger(step)) throw new Error('usage: versions [step] [promote|rollback]');
    if (action && !['promote', 'rollback'].includes(action)) throw new Error(`unknown action "${action}" (promote or rollback)`);
    const applied = readJson(join(HERE, 'applied.json'), { step: null });
    if (action === 'promote') {
      const r = await api('POST', `/atoll/versions/${step}/promote`);
      console.log(`atoll: promoted ${r.promoted.join(', ')} at step ${step}. Run /atoll-update to install.`);
      return;
    }
    if (action === 'rollback') {
      const r = await api('POST', `/atoll/versions/${step}/rollback`);
      console.log(`atoll: published step ${r.step}, identical to step ${step} (${r.changes.length} file change(s)). Run /atoll-update to install.`);
      return;
    }
    if (step != null) {
      const v = await api('GET', `/atoll/versions/${step}`);
      console.log(`step ${v.step}: ${v.summary}\n${v.rationale ? `\n${v.rationale}\n` : ''}\n${v.diff || '(no file changes)'}`);
      return;
    }
    const list = await api('GET', '/atoll/versions');
    const lines = list.versions.map((v) => {
      const flags = [
        v.step === applied.step ? 'installed' : null,
        v.score != null ? `score ${v.score.toFixed(2)}` : null,
        v.decidedBy === 'user' ? 'by user' : null,
        v.held.length ? `held: ${v.held.join(', ')}` : null,
      ].filter(Boolean);
      return `  step ${String(v.step).padEnd(3)} ${localTime(v.at)}  ${v.summary}${flags.length ? `  [${flags.join('; ')}]` : ''}`;
    });
    console.log(`atoll versions — scenario "${cfg.scenario}"\n${lines.join('\n')}`);
    if (list.pending?.length) console.log(`\n  ${list.pending.length} candidate(s) waiting for review — open ${cfg.url}/ to accept or reject.`);
  },

  async status() {
    const applied = readJson(join(HERE, 'applied.json'), { step: 0 });
    const s = await api('GET', `/atoll/scenarios/${encodeURIComponent(cfg.scenario)}`);
    console.log(
      `atoll ${cfg.url} — scenario "${s.name}"\n` +
        `  published step ${s.step}, installed step ${applied.step}\n` +
        `  records ${s.counts.records}, reports ${s.counts.reports} (open ${s.counts.open}, pending ${s.counts.pending})\n` +
        `  job ${s.job ?? 'idle'}`,
    );
  },

  async 'install-local'() {
    const q = (p) => `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
    const run = `node ${q(CLIENT)}`;
    const allowed = `Bash(${run}:*)`;
    const heredoc = (sub, tag) => `\`\`\`bash\n${run} ${sub} <<'${tag}'\n$ARGUMENTS\n${tag}\n\`\`\``;
    const commandsDir = join(ROOT, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    const files = {
      'atoll-harness.md': `---\ndescription: Ask atoll to change how this agent works — it writes, checks and versions the change\nargument-hint: <what the agent should do differently>\nallowed-tools: ${allowed}\n---\nFile this request with atoll. Run exactly this, keeping the user's words unchanged between the markers:\n\n${heredoc('ask', 'ATOLL_ASK')}\n\nRelay what it printed in one line. Do not make the change yourself: atoll turns the request into a rule, skill, command or hook, evaluates it, and publishes it as a harness version.\n`,
      'atoll-report.md': `---\ndescription: Tell atoll how the previous answer went — good, bad or a 0-1 score, plus what to change\nargument-hint: good|bad|<0-1> [what was right or wrong]\nallowed-tools: ${allowed}\n---\nReport on the previous turn (not this one). Run exactly:\n\n${heredoc('report', 'ATOLL_REPORT')}\n\nRelay what it printed in one line.\n`,
      'atoll-versions.md': `---\ndescription: List atoll harness versions, or show, promote or roll back one step\nargument-hint: [step] [promote|rollback]\nallowed-tools: ${allowed}\n---\nRun exactly:\n\n${heredoc('versions', 'ATOLL_VERSIONS')}\n\nShow the user the output. After a promote or rollback, suggest /atoll-update.\n`,
      'atoll-update.md': `---\ndescription: Install the latest atoll harness version into this project\nallowed-tools: ${allowed}\n---\n!\`${run} pull\`\n\nSummarize for the user what atoll installed above: files added, updated or removed, and anything kept or held. Slash commands work right away; new rules and skills fully apply from the next session.\n`,
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(commandsDir, name), content);

    const client = '"$CLAUDE_PROJECT_DIR/.claude/atoll/client.mjs"';
    const own = [
      { event: 'SessionStart', command: `node ${client} session-start`, timeout: 10 },
      ...(cfg.record ? [{ event: 'Stop', command: `node ${client} record`, timeout: 10 }] : []),
    ];
    // Keep promoted harness hooks already present; replace only atoll's own entries.
    const existingHarness = [];
    for (const file of [LOCAL_SETTINGS, SHARED_SETTINGS]) {
      for (const [event, groups] of Object.entries(readJson(join(ROOT, file), {}).hooks ?? {})) {
        for (const g of groups) for (const h of g.hooks ?? []) if (h.command?.includes('.claude/atoll/hooks/')) existingHarness.push({ event, matcher: g.matcher, command: h.command, timeout: h.timeout });
      }
    }
    writeHooks(ROOT, { own, harness: existingHarness });
    const excluded = gitExclude(ROOT, true);

    console.log(`atoll: installed into ${ROOT}`);
    console.log('  commands /atoll-harness /atoll-report /atoll-versions /atoll-update');
    console.log(`  hooks    SessionStart (update notice)${cfg.record ? ', Stop (records each turn to your local atoll server)' : ''} in .claude/settings.local.json`);
    if (excluded) console.log('  git      atoll\'s machine-local files are listed in .git/info/exclude');
    await commands.pull([]);
  },

  async uninstall() {
    const applied = readJson(join(HERE, 'applied.json'), { files: {} });
    applyBundle(ROOT, { step: 0, revision: null, files: [], held: [] });
    for (const name of ['atoll-harness.md', 'atoll-report.md', 'atoll-versions.md', 'atoll-update.md']) rmSync(join(ROOT, '.claude', 'commands', name), { force: true });
    writeHooks(ROOT, { own: [], harness: [] });
    gitExclude(ROOT, false);
    rmSync(HERE, { recursive: true, force: true });
    removeEmptyDirs(join(ROOT, '.claude', 'commands'), ROOT);
    console.log(`atoll: removed from ${ROOT} (${Object.keys(applied.files ?? {}).length} harness file(s), commands, hooks and the CLAUDE.md block)`);
  },
};

const isMain = (() => {
  try {
    // realpath: on macOS /var and /tmp are symlinks, and import.meta.url is already resolved.
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const [name, ...args] = process.argv.slice(2);
  const cmd = commands[name];
  if (!cmd) {
    console.error(`usage: ${relative(process.cwd(), CLIENT) || 'client.mjs'} <pull|ask|report|versions|status|uninstall|session-start|record|install-local>`);
    process.exit(2);
  }
  cmd(args).catch((e) => {
    console.error(`atoll: ${e.message}`);
    process.exit(1);
  });
}
