import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { UPSTREAMS } from './providers.js';
import { createServer, DEFAULTS } from './server.js';
import { VERSION } from './util.js';

const HELP = `atoll ${VERSION} — a harness that grows from how you use it

  Serve an agent, record feedback against receipts, let a recipe propose harness
  changes (rules, skills, slash commands, hooks), evaluate them, and publish the
  accepted ones as numbered versions your Claude Code project installs.

SERVER
  atoll serve [options]
      --port <n>              ${DEFAULTS.port}
      --host <addr>           ${DEFAULTS.host}
      --token <t>             bearer token (env ATOLL_TOKEN, default ${DEFAULTS.token})
      --state <dir>           ${DEFAULTS.state}
      --upstream <name>       ${UPSTREAMS.join(' | ')}   (default ${DEFAULTS.upstream}: your Claude Code login, no API key)
      --upstream-url <url>    anthropic: https://api.anthropic.com   openai: http://127.0.0.1:11434 (Ollama)
      --upstream-model <id>   model to serve and to grow with (env key: ATOLL_UPSTREAM_API_KEY)
      --grow-model <id>       model for the recipe only
      --judge-model <id>      model for the judge only
      --recipe <name|path>    refine | basic | ./my-recipe.mjs
      --selection <policy>    judge | manual | always      (default ${DEFAULTS.selection})
      --threshold <0-1>       judge score needed to publish (default ${DEFAULTS.threshold})
      --evaluator-cmd <sh>    run against every candidate tree; non-zero exit rejects
      -c, --config <file>     JSON with any of the options above (camelCase keys)

  atoll demo [--upstream mock|claude|...] [--keep]
      One full learning cycle in a temp directory. Offline with the default mock model.

CLIENT  (talk to a running server; --url, --token, -s/--scenario or ATOLL_URL, ATOLL_TOKEN, ATOLL_SCENARIO)
  atoll scenario create <name> [--selection manual]
  atoll scenario list
  atoll ask <text...>                          file a plain-language harness change
  atoll report --ref <receipt> [--score n] [--feedback text]
  atoll grow                                   run a learning cycle now
  atoll versions [step]                        history, or one step's diff
  atoll accept <candidate> | reject <candidate> [--reason text]
  atoll promote <step>                         release a step's held hooks / executable commands
  atoll rollback <step>                        publish a new step identical to an older one
  atoll install [--dir .]                      install the Claude Code harness into a project
  atoll status
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const short = { c: 'config', s: 'scenario', h: 'help' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const m = a.match(/^--?([A-Za-z][\w-]*)(?:=(.*))?$/);
    if (!m) {
      positional.push(a);
      continue;
    }
    const key = (a.startsWith('--') ? m[1] : short[m[1]] ?? m[1]).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (m[2] != null) flags[key] = m[2];
    else if (argv[i + 1] != null && !argv[i + 1].startsWith('-')) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return { positional, flags };
}

const NUMERIC = ['port', 'threshold', 'maxAttempts', 'debounceMs'];

function serverOptions(flags) {
  const fromFile = flags.config ? JSON.parse(readFileSync(flags.config, 'utf8')) : {};
  const opts = { ...fromFile };
  for (const key of Object.keys(DEFAULTS)) if (flags[key] != null) opts[key] = flags[key];
  for (const key of NUMERIC) if (opts[key] != null) opts[key] = Number(opts[key]);
  opts.token = flags.token ?? process.env.ATOLL_TOKEN ?? opts.token;
  opts.upstreamApiKey = process.env.ATOLL_UPSTREAM_API_KEY ?? opts.upstreamApiKey;
  return opts;
}

function clientConfig(flags) {
  return {
    url: String(flags.url ?? process.env.ATOLL_URL ?? `http://${DEFAULTS.host}:${DEFAULTS.port}`).replace(/\/+$/, ''),
    token: flags.token ?? process.env.ATOLL_TOKEN ?? DEFAULTS.token,
    scenario: flags.scenario ?? process.env.ATOLL_SCENARIO ?? DEFAULTS.defaultScenario,
  };
}

async function call(c, method, path, body, { raw = false } = {}) {
  let res;
  try {
    res = await fetch(c.url + path, {
      method,
      headers: { authorization: `Bearer ${c.token}`, 'x-atoll-scenario': c.scenario, 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`cannot reach ${c.url} (${e.cause?.code ?? e.message}) — is \`atoll serve\` running?`);
  }
  if (raw && res.ok) return res.text();
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${json.error ?? `HTTP ${res.status}`}${json.details ? ` — ${[].concat(json.details).join('; ')}` : ''}`);
  return json;
}

const localTime = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const teal = (s) => (process.stdout.isTTY ? `\x1b[36m${s}\x1b[0m` : s);

function printVersions(list) {
  for (const v of list.versions) {
    const flags = [v.score != null ? `score ${v.score.toFixed(2)}` : null, v.decidedBy === 'user' ? 'by you' : null, v.held.length ? `held: ${v.held.join(', ')}` : null].filter(Boolean);
    console.log(`  ${teal(`step ${v.step}`.padEnd(8))} ${dim(localTime(v.at))}  ${v.summary}${flags.length ? dim(`  [${flags.join('; ')}]`) : ''}`);
  }
  if (list.pending?.length) console.log(`\n  ${list.pending.length} candidate(s) pending review: ${list.pending.join(', ')}`);
}

const commands = {
  async serve({ flags }) {
    const options = serverOptions(flags);
    const app = await createServer(options).catch((e) => {
      if (e.code === 'EADDRINUSE') throw new Error(`port ${options.port ?? DEFAULTS.port} is already in use — is another \`atoll serve\` running? Choose another with --port`);
      throw e;
    });
    const { cfg, url, provider, recipe } = app;
    console.log(`${bold('atoll')} ${VERSION} listening on ${teal(url)}
  upstream   ${provider.name}${provider.model ? ` · ${provider.model}` : ' · default model'}
  recipe     ${recipe.name} · selection ${cfg.selection}${cfg.selection === 'judge' ? ` (threshold ${cfg.threshold})` : ''}${cfg.evaluatorCmd ? ` · evaluator: ${cfg.evaluatorCmd}` : ''}
  state      ${resolve(cfg.state)}
  token      ${cfg.token === DEFAULTS.token ? cfg.token : '(custom)'}
  dashboard  ${url}/

  install into a Claude Code project:
    curl -fsS -H "Authorization: Bearer $ATOLL_TOKEN" -H "x-atoll-scenario: my-harness" \\
      '${url}/atoll/harness/install?target=claude-code' | bash`);
    const stop = async () => {
      await app.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  },

  async scenario({ positional, flags }) {
    const c = clientConfig(flags);
    const [sub, name] = positional;
    if (sub === 'create') {
      if (!name) throw new Error('usage: atoll scenario create <name>');
      const s = await call(c, 'POST', '/atoll/scenarios', { name, selection: flags.selection });
      console.log(`scenario ${s.name} · step ${s.step} · selection ${s.selection}`);
    } else if (!sub || sub === 'list') {
      const { scenarios } = await call(c, 'GET', '/atoll/scenarios');
      if (!scenarios.length) console.log('no scenarios yet');
      for (const s of scenarios) console.log(`  ${s.name.padEnd(24)} step ${String(s.step).padEnd(4)} records ${s.counts.records}  open ${s.counts.open}  pending ${s.counts.pending}`);
    } else throw new Error('usage: atoll scenario create <name> | list');
  },

  async ask({ positional, flags }) {
    const text = positional.join(' ').trim();
    if (!text) throw new Error('usage: atoll ask <what the agent should do differently>');
    const c = clientConfig(flags);
    const r = await call(c, 'POST', '/atoll/harness/ask', { text, source: 'cli' });
    console.log(`filed ${r.id} for scenario ${c.scenario} — watch it with: atoll versions`);
  },

  async report({ flags }) {
    const c = clientConfig(flags);
    const references = String(flags.ref ?? '').split(',').filter(Boolean);
    const body = { references, source: 'cli' };
    if (flags.score != null) body.score = Number(flags.score);
    if (flags.feedback != null) body.feedback = String(flags.feedback);
    const r = await call(c, 'POST', '/atoll/report', body);
    console.log(`report ${r.id} → ${references.join(', ')}`);
  },

  async grow({ flags }) {
    const c = clientConfig(flags);
    const r = await call(c, 'POST', '/atoll/grow');
    if (r.status === 'idle') return console.log(r.reason);
    console.log(`${r.id}: ${r.status}${r.step ? ` → step ${r.step}` : ''}\n  ${r.summary}\n  ${dim(r.decision?.reason ?? '')}`);
  },

  async versions({ positional, flags }) {
    const c = clientConfig(flags);
    if (positional[0] != null) {
      const v = await call(c, 'GET', `/atoll/versions/${Number(positional[0])}`);
      console.log(`${bold(`step ${v.step}`)}: ${v.summary}\n${v.rationale ? `${dim(v.rationale)}\n` : ''}\n${v.diff || '(no file changes)'}`);
      return;
    }
    console.log(`${bold('versions')} — scenario ${c.scenario}`);
    printVersions(await call(c, 'GET', '/atoll/versions'));
  },

  async accept({ positional, flags }) {
    const c = await call(clientConfig(flags), 'POST', `/atoll/candidates/${positional[0]}/accept`, { reason: flags.reason });
    console.log(`accepted ${c.id} → step ${c.step}`);
  },

  async reject({ positional, flags }) {
    const c = await call(clientConfig(flags), 'POST', `/atoll/candidates/${positional[0]}/reject`, { reason: flags.reason });
    console.log(`rejected ${c.id}`);
  },

  async promote({ positional, flags }) {
    const r = await call(clientConfig(flags), 'POST', `/atoll/versions/${Number(positional[0])}/promote`);
    console.log(`promoted at step ${r.step}: ${r.promoted.join(', ')}`);
  },

  async rollback({ positional, flags }) {
    const r = await call(clientConfig(flags), 'POST', `/atoll/versions/${Number(positional[0])}/rollback`);
    console.log(`published step ${r.step} (restores step ${r.restored}; ${r.changes.length} file change(s))`);
  },

  async install({ flags }) {
    const c = clientConfig(flags);
    const dir = resolve(flags.dir ?? '.');
    const script = await call(c, 'GET', '/atoll/harness/install?target=claude-code', null, { raw: true });
    await runScript(script, dir);
  },

  async status({ flags }) {
    const c = clientConfig(flags);
    const health = await call(c, 'GET', '/healthz');
    console.log(`atoll ${health.version} at ${c.url} · upstream ${health.upstream}${health.model ? ` (${health.model})` : ''} · recipe ${health.recipe}`);
    const { scenarios } = await call(c, 'GET', '/atoll/scenarios');
    if (!scenarios.some((x) => x.name === c.scenario)) {
      const others = scenarios.map((x) => x.name);
      console.log(`scenario ${c.scenario} does not exist yet — \`atoll install\` or \`atoll scenario create ${c.scenario}\` creates it${others.length ? ` (existing: ${others.join(', ')})` : ''}`);
      return;
    }
    const s = await call(c, 'GET', `/atoll/scenarios/${encodeURIComponent(c.scenario)}`);
    console.log(`scenario ${s.name}: step ${s.step}, records ${s.counts.records}, reports ${s.counts.reports} (open ${s.counts.open}, pending ${s.counts.pending}, addressed ${s.counts.addressed}), job ${s.job ?? 'idle'}`);
  },

  demo: (args) => demo(args),
};

function runScript(script, cwd, { quiet = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', ['-s'], { cwd, env: { ...process.env, ATOLL_PROJECT_DIR: cwd }, stdio: ['pipe', quiet ? 'pipe' : 'inherit', 'inherit'] });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.on('close', (code) => (code === 0 ? resolvePromise(out) : reject(new Error(`install script exited ${code}`))));
    child.stdin.end(script);
  });
}

function tree(dir, root = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tree(p, root) : [relative(root, p)];
  });
}

async function demo({ flags }) {
  const upstream = flags.upstream ?? 'mock';
  const work = mkdtempSync(join(tmpdir(), 'atoll-demo-'));
  const project = join(work, 'project');
  const app = await createServer({
    ...serverOptions(flags),
    upstream,
    port: 0,
    state: join(work, 'state'),
    debounceMs: 200,
    log: () => {},
  });
  const c = { url: app.url, token: app.cfg.token, scenario: 'hello-atoll' };
  const step = (n, label, text) => console.log(`\n${teal(n)} ${bold(label)}  ${dim(text)}`);
  try {
    console.log(`${bold('atoll demo')} — upstream ${app.provider.name}${upstream === 'mock' ? ' (deterministic, offline)' : ''} · ${dim(work)}`);

    step('1', 'Serve', 'an OpenAI-compatible request through the scenario');
    const res = await fetch(`${app.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.token}`, 'x-atoll-scenario': c.scenario, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Return exactly: atoll is ready' }] }),
    });
    const receipt = res.headers.get('x-atoll-record-id');
    const answer = (await res.json()).choices?.[0]?.message?.content;
    console.log(`  answer   ${JSON.stringify(answer)}\n  receipt  ${receipt}`);

    step('2', 'Observe', 'a scored report on that receipt, and two plain-language asks');
    const matched = answer?.trim() === 'atoll is ready';
    const rpt = await call(c, 'POST', '/atoll/report', { score: matched ? 1 : 0, feedback: matched ? 'matched' : 'wrong answer', references: [receipt] });
    console.log(`  report   ${rpt.id}  score ${rpt.score}  (a good score is kept as a positive example, not a trigger)`);
    const askText = 'when I ask you to fix a bug, reproduce it with a failing test first';
    const ask = await call(c, 'POST', '/atoll/harness/ask', { text: askText });
    const pref = await call(c, 'POST', '/atoll/harness/ask', { text: 'Use pnpm for every install and script command; never npm or yarn.' });
    console.log(`  ask      ${ask.id}  "${askText}"\n  ask      ${pref.id}  "Use pnpm for every install and script command; never npm or yarn."`);

    step('3', 'Grow', `recipe "${app.recipe.name}" drafts a change, static checks + judge evaluate it`);
    const s = app.store.get(c.scenario);
    const started = Date.now();
    while (app.engine.timers.size || app.engine.running.size || ![...s.candidates.values()].some((x) => x.status !== 'running')) {
      if (Date.now() - started > 900_000) throw new Error('timed out waiting for the recipe');
      await new Promise((r) => setTimeout(r, 150));
    }
    for (const cand of s.candidates.values()) {
      console.log(`  ${cand.id}  ${cand.status}${cand.step ? ` → step ${cand.step}` : ''}  "${cand.summary}"`);
      for (const ch of cand.changes) console.log(`    ${ch.op.padEnd(6)} ${ch.path}`);
      console.log(`    ${dim(cand.decision?.reason ?? '')}`);
    }

    step('4', 'Commit', 'accepted updates become numbered steps in a git history');
    printVersions(await call(c, 'GET', '/atoll/versions'));

    step('5', 'Surface', 'install the harness into a Claude Code project');
    const script = await call(c, 'GET', '/atoll/harness/install?target=claude-code', null, { raw: true });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'CLAUDE.md'), '# my project\n\nNotes the user wrote stay untouched.\n');
    const out = await runScript(script, project, { quiet: true });
    console.log(out.trimEnd().split('\n').map((l) => `  ${l}`).join('\n'));
    console.log(`\n  ${bold('project files')}`);
    for (const f of tree(project).filter((f) => !f.startsWith('.claude/atoll/')).sort()) console.log(`    ${f}`);
    console.log(`\n  ${bold('CLAUDE.md')}`);
    console.log(readFileSync(join(project, 'CLAUDE.md'), 'utf8').trimEnd().split('\n').map((l) => `    ${dim(l)}`).join('\n'));

    console.log(`\n${bold('Done.')} A real run: ${teal('atoll serve')} then, in your project, the curl | bash installer and ${teal('/atoll-harness <ask>')}.`);
    if (flags.keep) console.log(dim(`kept ${work}`));
  } finally {
    await app.close();
    if (!flags.keep) rmSync(work, { recursive: true, force: true });
  }
}

export async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') return console.log(HELP);
  if (name === '--version' || name === '-v') return console.log(VERSION);
  const cmd = commands[name];
  if (!cmd) {
    console.error(`unknown command "${name}"\n\n${HELP}`);
    process.exit(2);
  }
  try {
    await cmd(parseArgs(rest));
  } catch (e) {
    console.error(`atoll: ${e.message}`);
    process.exit(1);
  }
}
