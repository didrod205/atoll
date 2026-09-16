// refine — the built-in harness recipe. Turns open feedback into the smallest
// change to a Claude Code harness: a rule, a skill, a slash command, or a hook.

import { renderFeedback, renderFiles } from '../evaluate.js';
import { extractJson } from '../util.js';

const SYSTEM = `ATOLL:GROW
You maintain the harness of one user's coding agent (Claude Code). The harness is a small set of text files that shape how the agent works. You receive feedback the user gave about the agent and propose the smallest change to the harness that makes the agent behave the way the user wants from now on.

Harness surfaces — paths are enforced:
- rules/<name>.md — an always-on instruction, placed in CLAUDE.md. One rule per file, 1-5 lines, imperative and specific. For standing preferences that apply across tasks ("Use pnpm, never npm or yarn.").
- skills/<name>/SKILL.md — a procedure the agent loads when a task matches. Must start with frontmatter:
    ---
    name: <name>            (equal to the directory name)
    description: <when to use it; the agent decides from this line alone whether to load the skill>
    ---
  For multi-step methods tied to a kind of task ("When fixing a bug: reproduce it with a failing test first, then ...").
- commands/<name>.md — a slash command the user types as /<name>. Optional frontmatter: description, argument-hint. $ARGUMENTS is replaced with what the user types after the command. For named workflows the user triggers.
- hooks/<name>.json plus a script hooks/<name>.sh — automation Claude Code runs on an event. JSON: {"event": "PostToolUse", "matcher": "Edit|Write", "command": "hooks/<name>.sh", "timeout": 30}. Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop, PreCompact, Notification, SessionEnd. Hooks run code on the user's machine and are held until the user promotes them. Only for behavior that must be enforced mechanically, where an instruction would not be reliable.

How to choose:
- Smallest surface that works: rule, then skill, then command, then hook.
- Edit an existing file rather than adding an overlapping one. Delete a file when feedback says it is wrong. Write the full new content of every file you change.
- General enough to apply next time, no broader than the feedback supports. Do not invent preferences the user did not express.
- A complaint about one specific answer that implies no standing preference is skipped, with the reason.
- If a previous attempt was rejected, the rejection says why; fix that.
- No secrets, tokens, or machine-specific absolute paths. <name> is lowercase kebab-case.
- Write harness text in the language the user wrote the feedback in.

Reply with one JSON object and nothing else:
{
  "summary": "<one line, imperative, at most 80 chars>",
  "rationale": "<why this surface and this wording, 1-3 sentences>",
  "changes": [{"op": "write", "path": "rules/example.md", "content": "<full file content>"}, {"op": "delete", "path": "<existing path>"}],
  "addresses": ["<feedback id this change resolves>"],
  "skipped": [{"id": "<feedback id>", "why": "<reason>"}]
}
Every feedback id appears in exactly one of addresses or skipped. If nothing should change, return "changes": [] and skip every id.`;

const MAX_BATCH = 8;

function isNegativeOrUnscored(r) {
  return r.score == null || r.score < 0.5;
}

function hasText(r) {
  return r.feedback != null && r.feedback !== '';
}

export default {
  name: 'refine',
  description: 'Turns asks, low-scored feedback and repeated corrections into rules, skills, commands and hooks.',

  /** Should this new report wake the grower? */
  triggers(report, openReports) {
    if (report.kind === 'ask') return true;
    if (report.kind === 'report') return hasText(report) && isNegativeOrUnscored(report);
    if (report.kind === 'implicit') return openReports.filter((r) => r.kind === 'implicit').length >= 2;
    return false;
  },

  /** Which open reports go into the next update. */
  select(openReports) {
    const asks = openReports.filter((r) => r.kind === 'ask');
    const reports = openReports.filter((r) => r.kind === 'report' && hasText(r) && isNegativeOrUnscored(r));
    const implicit = openReports.filter((r) => r.kind === 'implicit');
    const useImplicit = implicit.length >= 2 || asks.length + reports.length > 0;
    return [...asks, ...reports, ...(useImplicit ? implicit : [])].slice(0, MAX_BATCH);
  },

  async grow({ step, files, reports, records, rejections, history, praise, complete }) {
    const parts = [
      `<harness step="${step}">`,
      renderFiles(files),
      '</harness>',
      '',
    ];
    if (history.length) {
      parts.push('<recent_steps>', ...history.map((h) => `step ${h.step}: ${h.summary}`), '</recent_steps>', '');
    }
    parts.push(...reports.map((r) => renderFeedback(r, { records, previous: rejections.get(r.id) ?? [] })));
    if (praise.length) {
      parts.push('', '<working_well note="positive feedback — keep these behaviors intact">', ...praise.map((r) => renderFeedback(r, { records })), '</working_well>');
    }
    const res = await complete({ system: SYSTEM, messages: [{ role: 'user', content: parts.join('\n') }], maxTokens: 8000 });
    const json = extractJson(res.text);
    return {
      summary: String(json.summary ?? '').slice(0, 120) || 'update harness',
      rationale: String(json.rationale ?? ''),
      changes: Array.isArray(json.changes) ? json.changes : [],
      addresses: Array.isArray(json.addresses) ? json.addresses.map(String) : [],
      skipped: Array.isArray(json.skipped) ? json.skipped.map((s) => ({ id: String(s?.id), why: String(s?.why ?? '') })) : [],
      raw: res.text,
      model: res.model,
    };
  },
};
