// Step 4a — decide whether a candidate may become the next harness version.
//
//   static checks  paths, shapes, sizes, secrets        (always; failure rejects)
//   evaluator      your command against the new tree    (optional; failure rejects)
//   judge          model review against the feedback    (selection "judge")
//   policy         judge | manual | always

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extractJson, truncate, unifiedDiff } from './util.js';

export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'Notification',
];

const NAME = '[a-z0-9][a-z0-9-]{0,63}';
const PATTERNS = {
  rule: new RegExp(`^rules/${NAME}\\.md$`),
  skill: new RegExp(`^skills/${NAME}/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`),
  command: new RegExp(`^commands/${NAME}\\.md$`),
  hook: new RegExp(`^hooks/${NAME}\\.(json|sh|mjs|js|py)$`),
};

const SECRET = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{32,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const LIMITS = { changes: 20, fileBytes: 32_000, totalBytes: 128_000, ruleChars: 1_500, rulesTotalChars: 12_000 };

export function kindOf(path) {
  for (const [kind, re] of Object.entries(PATTERNS)) if (re.test(path)) return kind;
  return null;
}

export function parseFrontmatter(md) {
  const m = String(md).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: null, body: md };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, body: md.slice(m[0].length) };
}

/**
 * Quote frontmatter values a strict YAML parser rejects — models write
 * `description: Use when: the user ...` all the time.
 */
export function normalizeFrontmatter(md) {
  if (typeof md !== 'string') return md;
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return md;
  const lines = m[1].split(/\r?\n/).map((line) => {
    const kv = line.match(/^([A-Za-z0-9_-]+):[ \t]+(.+)$/);
    if (!kv) return line;
    const v = kv[2].trim();
    if (/^(["']).*\1$/.test(v) || /^[[{|>]/.test(v)) return line;
    if (!/: | #/.test(v) && !/^[&*!%@`,?#-]/.test(v)) return line;
    return `${kv[1]}: ${JSON.stringify(v)}`;
  });
  return `---\n${lines.join('\n')}\n---${m[2]}${md.slice(m[0].length)}`;
}

/**
 * Content that makes Claude Code run something on the user's machine. These
 * files are committed but held from delivery until the user promotes them.
 */
export function isExecutable(path, content = '') {
  const kind = kindOf(path);
  if (kind === 'hook') return true;
  if (kind === 'skill' && !path.endsWith('.md')) return true;
  if (kind === 'command' || kind === 'skill') {
    const { data } = parseFrontmatter(content);
    if (data?.['allowed-tools']) return true;
    if (/(^|\s)!`/.test(content)) return true; // slash-command bash execution
  }
  return false;
}

/** Apply a candidate's changes to a file map without touching disk. */
export function applyChanges(files, changes) {
  const next = new Map(files);
  for (const c of changes) {
    if (c.op === 'delete') next.delete(c.path);
    else next.set(c.path, c.content);
  }
  return next;
}

export function staticCheck(changes, current, knownIds = []) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(changes)) return { ok: false, errors: ['changes must be an array'], warnings, executable: [] };
  if (changes.length > LIMITS.changes) errors.push(`${changes.length} changes; at most ${LIMITS.changes} per step`);
  const seen = new Set();
  let total = 0;
  for (const [i, c] of changes.entries()) {
    const where = `changes[${i}]`;
    if (!c || typeof c.path !== 'string') {
      errors.push(`${where}: path is required`);
      continue;
    }
    if (c.path.includes('..') || c.path.startsWith('/') || c.path.includes('\\') || /(^|\/)\./.test(c.path)) {
      errors.push(`${where}: path "${c.path}" escapes the harness or is hidden`);
      continue;
    }
    const kind = kindOf(c.path);
    if (!kind) {
      errors.push(`${where}: "${c.path}" is not a harness path (rules/<name>.md, skills/<name>/SKILL.md, commands/<name>.md, hooks/<name>.json)`);
      continue;
    }
    if (c.kind && c.kind !== kind) warnings.push(`${where}: kind "${c.kind}" does not match path; treated as ${kind}`);
    if (seen.has(c.path)) errors.push(`${where}: "${c.path}" changed twice`);
    seen.add(c.path);
    if (c.op === 'delete') {
      if (!current.has(c.path)) errors.push(`${where}: cannot delete "${c.path}", it does not exist`);
      continue;
    }
    if (c.op !== 'write') {
      errors.push(`${where}: op must be "write" or "delete"`);
      continue;
    }
    if (typeof c.content !== 'string' || !c.content.trim()) {
      errors.push(`${where}: "${c.path}" has empty content`);
      continue;
    }
    const bytes = Buffer.byteLength(c.content);
    total += bytes;
    if (bytes > LIMITS.fileBytes) errors.push(`${where}: "${c.path}" is ${bytes} bytes (max ${LIMITS.fileBytes})`);
    for (const re of SECRET) if (re.test(c.content)) errors.push(`${where}: "${c.path}" looks like it contains a credential`);
    if (/\/(Users|home)\/[^/\s]+\//.test(c.content)) warnings.push(`${where}: "${c.path}" contains a machine-specific absolute path`);
    if (kind === 'rule') {
      if (c.content.length > LIMITS.ruleChars) errors.push(`${where}: rule is ${c.content.length} chars (max ${LIMITS.ruleChars}) — a long procedure belongs in a skill`);
      if (parseFrontmatter(c.content).data) warnings.push(`${where}: rules do not take frontmatter`);
    }
    if (kind === 'skill' && c.path.endsWith('/SKILL.md')) {
      const dir = c.path.split('/')[1];
      const { data } = parseFrontmatter(c.content);
      if (!data) errors.push(`${where}: SKILL.md needs YAML frontmatter with name and description`);
      else {
        if (data.name !== dir) errors.push(`${where}: frontmatter name "${data.name ?? ''}" must equal directory "${dir}"`);
        if (!data.description || data.description.length > 1024) errors.push(`${where}: description is required (1-1024 chars)`);
      }
    }
    if (kind === 'command' && !parseFrontmatter(c.content).data?.description) {
      warnings.push(`${where}: command has no description frontmatter`);
    }
    if (kind === 'hook' && c.path.endsWith('.json')) {
      let spec;
      try {
        spec = JSON.parse(c.content);
      } catch {
        errors.push(`${where}: hook spec is not valid JSON`);
        continue;
      }
      if (!HOOK_EVENTS.includes(spec.event)) errors.push(`${where}: hook event must be one of ${HOOK_EVENTS.join(', ')}`);
      if (typeof spec.command !== 'string' || !PATTERNS.hook.test(spec.command) || spec.command.endsWith('.json')) {
        errors.push(`${where}: hook "command" must name a script in hooks/ (hooks/<name>.sh|mjs|js|py)`);
      }
    }
  }
  if (total > LIMITS.totalBytes) errors.push(`candidate writes ${total} bytes (max ${LIMITS.totalBytes})`);

  const after = applyChanges(current, changes.filter((c) => c && typeof c.path === 'string'));
  const skillDirs = new Set([...after.keys()].filter((p) => p.startsWith('skills/')).map((p) => p.split('/')[1]));
  for (const d of skillDirs) if (!after.has(`skills/${d}/SKILL.md`)) errors.push(`skills/${d}/ has files but no SKILL.md`);
  for (const [p, content] of after) {
    if (!p.startsWith('hooks/') || !p.endsWith('.json')) continue;
    try {
      const cmd = JSON.parse(content).command;
      if (typeof cmd === 'string' && !after.has(cmd)) errors.push(`${p}: script "${cmd}" is not in the harness`);
    } catch {}
  }
  const rulesChars = [...after].filter(([p]) => p.startsWith('rules/')).reduce((n, [, v]) => n + v.length, 0);
  if (rulesChars > LIMITS.rulesTotalChars) warnings.push(`rules total ${rulesChars} chars — CLAUDE.md is getting heavy; consider consolidating`);

  const executable = changes.filter((c) => c?.op === 'write' && kindOf(c.path) && isExecutable(c.path, c.content)).map((c) => c.path);
  return { ok: errors.length === 0, errors, warnings, executable, knownIds };
}

export function candidateDiff(current, changes) {
  return changes
    .filter((c) => c && typeof c.path === 'string')
    .map((c) => unifiedDiff(current.get(c.path) ?? null, c.op === 'delete' ? null : c.content, { path: c.path }))
    .join('');
}

export function renderFiles(files, { maxChars = 40_000 } = {}) {
  if (!files.size) return '(empty — no rules, skills, commands or hooks yet)';
  let used = 0;
  const parts = [];
  for (const [path, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const block = `<file path="${path}">\n${content.trimEnd()}\n</file>`;
    if (used + block.length > maxChars) {
      parts.push(`<file path="${path}" omitted="budget">${content.split('\n').slice(0, 3).join('\n')}</file>`);
      continue;
    }
    used += block.length;
    parts.push(block);
  }
  return parts.join('\n');
}

export function renderFeedback(report, { records = new Map(), previous = [] } = {}) {
  const attrs = [`id="${report.id}"`, `kind="${report.kind}"`];
  if (report.score != null) attrs.push(`score="${report.score}"`);
  const text = typeof report.feedback === 'string' ? report.feedback : report.feedback == null ? '(no text — score only)' : JSON.stringify(report.feedback, null, 2);
  let out = `<feedback ${attrs.join(' ')}>\n${text.trim()}\n`;
  for (const ref of report.references ?? []) {
    const r = records.get(ref);
    if (!r) continue;
    const user = [...(r.request?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
    out += `<interaction record="${r.id}">\n<user>${truncate(user, 1500)}</user>\n`;
    if (r.tools?.length) out += `<tools>${truncate(r.tools.map((t) => `${t.name}${t.input ? `: ${t.input}` : ''}`).join('\n'), 1500)}</tools>\n`;
    out += `<assistant>${truncate(r.response?.text ?? '', 1500)}</assistant>\n</interaction>\n`;
  }
  for (const p of previous) out += `<previous_attempt candidate="${p.id}" rejected="${truncate(p.reason, 400)}"/>\n`;
  return `${out}</feedback>`;
}

const JUDGE_SYSTEM = `ATOLL:JUDGE
You review a proposed change to a coding agent's harness — Claude Code rules (CLAUDE.md), skills, slash commands and hooks — before it is published to the user's agent. Be strict and concrete.

For each feedback item to address: would the agent, with the harness after this change, actually behave the way the feedback asks next time? A vague or mis-scoped change does not address it.
For each earlier feedback item: does the change contradict or undo what it established? Only list real conflicts.
Score the change 0..1: specific and actionable wording, the right surface (rule for standing preferences, skill for task procedures, command for user-triggered workflows, hook only for mechanical enforcement), no invented preferences, no duplication with existing files.

Reply with one JSON object and nothing else:
{"verdicts":[{"id":"<feedback id>","addressed":true,"why":"<one sentence>"}],"regressions":[{"id":"<earlier feedback id>","why":"<one sentence>"}],"score":0.0,"notes":"<one sentence>"}`;

export async function judge(provider, { reports, earlier, records, summary, diff, after, model }) {
  const prompt = [
    '<feedback_to_address>',
    ...reports.map((r) => renderFeedback(r, { records })),
    '</feedback_to_address>',
    '',
    '<earlier_feedback>',
    ...(earlier.length ? earlier.map((r) => renderFeedback(r)) : ['(none)']),
    '</earlier_feedback>',
    '',
    `<proposed_change summary="${summary.replace(/"/g, "'")}">`,
    diff || '(no textual change)',
    '</proposed_change>',
    '',
    '<harness_after>',
    renderFiles(after, { maxChars: 30_000 }),
    '</harness_after>',
  ].join('\n');
  const res = await provider.complete({ system: JUDGE_SYSTEM, messages: [{ role: 'user', content: prompt }], maxTokens: 2000 }, { model });
  const json = extractJson(res.text);
  const verdicts = (Array.isArray(json.verdicts) ? json.verdicts : []).map((v) => ({ id: String(v.id), addressed: v.addressed === true, why: String(v.why ?? '') }));
  const regressions = (Array.isArray(json.regressions) ? json.regressions : []).map((v) => ({ id: String(v.id), why: String(v.why ?? '') }));
  const score = Math.max(0, Math.min(1, Number(json.score) || 0));
  return { verdicts, regressions, score, notes: String(json.notes ?? ''), model: res.model };
}

export function runEvaluator(cmd, files, { timeoutMs = 300_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atoll-eval-'));
  for (const [p, content] of files) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd: dir, env: { ...process.env, ATOLL_HARNESS_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d) => (out = (out + d).slice(-8000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ ok: code === 0, code, signal, output: out });
    });
  });
}

/** The selection policy. Returns { status, reason }. */
export function decide({ checks, changes, selection, threshold, addresses }) {
  if (!checks.static.ok) return { status: 'rejected', reason: `static checks failed: ${checks.static.errors.join('; ')}` };
  if (!changes.length) return { status: 'noop', reason: 'recipe proposed no change' };
  if (!addresses.length) return { status: 'rejected', reason: 'the change does not claim to address any feedback' };
  if (checks.evaluator && !checks.evaluator.ok) return { status: 'rejected', reason: `evaluator exited ${checks.evaluator.code ?? checks.evaluator.signal}` };
  if (selection === 'manual') return { status: 'pending', reason: 'selection is manual — waiting for review' };
  if (selection === 'always') return { status: 'accepted', reason: 'selection is always — static checks passed' };
  const j = checks.judge;
  if (!j) return { status: 'pending', reason: 'no judge result — waiting for review' };
  if (j.error) return { status: 'pending', reason: `judge failed (${j.error}) — waiting for review` };
  const missing = addresses.filter((id) => !j.verdicts.find((v) => v.id === id && v.addressed));
  if (missing.length) {
    const why = missing.map((id) => j.verdicts.find((v) => v.id === id)?.why || 'no verdict').join('; ');
    return { status: 'rejected', reason: `judge: does not address ${missing.join(', ')} — ${why}` };
  }
  if (j.regressions.length) return { status: 'rejected', reason: `judge: conflicts with earlier feedback — ${j.regressions.map((r) => `${r.id}: ${r.why}`).join('; ')}` };
  if (j.score < threshold) return { status: 'rejected', reason: `judge score ${j.score.toFixed(2)} below threshold ${threshold}${j.notes ? ` — ${j.notes}` : ''}` };
  return { status: 'accepted', reason: `judge score ${j.score.toFixed(2)}, all feedback addressed, no regressions` };
}
