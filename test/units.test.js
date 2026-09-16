import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, isExecutable, normalizeFrontmatter, parseFrontmatter, staticCheck } from '../src/evaluate.js';
import { looksLikeCorrection } from '../src/observe.js';
import { renderTranscript } from '../src/providers.js';
import { fromAnthropic, fromOpenAI, streamCollector, toFormatStream } from '../src/translate.js';
import { extractJson, unifiedDiff } from '../src/util.js';
import { lastTurn, mergeHooks, spliceRulesBlock } from '../harness/claude-code/client.mjs';

test('fromOpenAI folds system messages and merges consecutive roles', () => {
  const c = fromOpenAI({
    model: 'm',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'a' },
      { role: 'user', content: [{ type: 'text', text: 'b' }, { type: 'image_url', image_url: {} }] },
      { role: 'assistant', content: null, tool_calls: [{ function: { name: 'ls', arguments: '{}' } }] },
      { role: 'tool', content: 'x.txt' },
    ],
    max_tokens: 10,
  });
  assert.equal(c.system, 'be brief');
  assert.deepEqual(c.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(c.messages[0].content, 'a\n\nb\n[image]');
  assert.match(c.messages[1].content, /\[tool call ls\]/);
  assert.equal(c.maxTokens, 10);
});

test('fromAnthropic renders blocks as text', () => {
  const c = fromAnthropic({
    system: [{ type: 'text', text: 'sys' }],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'out' }] }] },
    ],
  });
  assert.equal(c.system, 'sys');
  assert.match(c.messages[1].content, /Bash.*ls/);
  assert.match(c.messages[2].content, /tool result\]\nout/);
});

for (const format of ['openai', 'anthropic']) {
  test(`${format} SSE replay round-trips through the stream collector`, () => {
    const sse = toFormatStream(format, { text: 'hello wörld', usage: { input: 3, output: 2 }, stopReason: 'end' }, 'm');
    const col = streamCollector(format);
    // Feed in awkward chunk sizes to exercise line buffering.
    for (let i = 0; i < sse.length; i += 7) col.push(sse.slice(i, i + 7));
    const r = col.result();
    assert.equal(r.text, 'hello wörld');
    assert.equal(r.usage.output, 2);
  });
}

test('extractJson finds objects in fences and prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Here: {"a":"}{","b":{"c":3}} trailing'), { a: '}{', b: { c: 3 } });
  assert.throws(() => extractJson('no json'));
});

test('unifiedDiff produces hunks and handles new and deleted files', () => {
  const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', { path: 'rules/x.md' });
  assert.equal(d, '--- a/rules/x.md\n+++ b/rules/x.md\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
  assert.equal(unifiedDiff(null, 'new\n', { path: 'p' }), '--- /dev/null\n+++ b/p\n@@ -0,0 +1,1 @@\n+new\n');
  assert.match(unifiedDiff('old\n', null, { path: 'p' }), /\+\+\+ \/dev\/null/);
  assert.equal(unifiedDiff('same', 'same'), '');
});

test('staticCheck enforces harness paths, skill frontmatter, secrets and hook wiring', () => {
  const current = new Map([['rules/keep.md', '- keep\n']]);
  const bad = staticCheck(
    [
      { op: 'write', path: '../escape.md', content: 'x' },
      { op: 'write', path: 'notes/random.md', content: 'x' },
      { op: 'write', path: 'skills/fix-bugs/SKILL.md', content: '---\nname: other\ndescription: d\n---\nbody' },
      { op: 'write', path: 'rules/key.md', content: `token ${'sk-ant-'}api03-${'x'.repeat(30)}` },
      { op: 'write', path: 'hooks/fmt.json', content: '{"event":"PostToolUse","command":"hooks/fmt.sh"}' },
      { op: 'delete', path: 'rules/missing.md' },
    ],
    current,
  );
  assert.equal(bad.ok, false);
  const errors = bad.errors.join('\n');
  assert.match(errors, /escapes the harness/);
  assert.match(errors, /not a harness path/);
  assert.match(errors, /must equal directory "fix-bugs"/);
  assert.match(errors, /credential/);
  assert.match(errors, /script "hooks\/fmt.sh" is not in the harness/);
  assert.match(errors, /cannot delete/);

  const good = staticCheck(
    [
      { op: 'write', path: 'skills/fix-bugs/SKILL.md', content: '---\nname: fix-bugs\ndescription: When fixing a bug\n---\n1. Reproduce.' },
      { op: 'write', path: 'hooks/fmt.json', content: '{"event":"PostToolUse","matcher":"Edit","command":"hooks/fmt.sh"}' },
      { op: 'write', path: 'hooks/fmt.sh', content: 'prettier --write .' },
      { op: 'delete', path: 'rules/keep.md' },
    ],
    current,
  );
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.executable.sort(), ['hooks/fmt.json', 'hooks/fmt.sh']);
});

test('isExecutable flags hooks, skill scripts and commands that run shell', () => {
  assert.equal(isExecutable('rules/a.md', '- run `ls`'), false);
  assert.equal(isExecutable('commands/a.md', '---\ndescription: d\n---\nDo $ARGUMENTS'), false);
  assert.equal(isExecutable('commands/a.md', 'Status: !`git status`'), true);
  assert.equal(isExecutable('commands/a.md', '---\nallowed-tools: Bash(git:*)\n---\nx'), true);
  assert.equal(isExecutable('skills/a/scripts/run.sh', 'echo'), true);
  assert.equal(isExecutable('hooks/a.json', '{}'), true);
  assert.deepEqual(parseFrontmatter('---\nname: "x"\n---\nbody').data, { name: 'x' });
});

test('normalizeFrontmatter quotes values strict YAML would reject and nothing else', () => {
  const md = '---\nname: fix-bugs\ndescription: Use when: a bug is reported # always\nallowed-tools: Bash(git add:*)\nargument-hint: [file]\ntitle: "already: quoted"\n---\nBody: stays as is\n';
  assert.equal(
    normalizeFrontmatter(md),
    '---\nname: fix-bugs\ndescription: "Use when: a bug is reported # always"\nallowed-tools: Bash(git add:*)\nargument-hint: [file]\ntitle: "already: quoted"\n---\nBody: stays as is\n',
  );
  assert.equal(parseFrontmatter(normalizeFrontmatter(md)).data.description, 'Use when: a bug is reported # always');
  assert.equal(normalizeFrontmatter('no frontmatter: here'), 'no frontmatter: here');
});

test('decide applies the selection policy in order', () => {
  const ok = { static: { ok: true, errors: [] } };
  const changes = [{ op: 'write', path: 'rules/a.md', content: 'x' }];
  const base = { changes, threshold: 0.7, addresses: ['r1'] };
  assert.equal(decide({ ...base, checks: { static: { ok: false, errors: ['e'] } }, selection: 'always' }).status, 'rejected');
  assert.equal(decide({ ...base, changes: [], checks: ok, selection: 'judge' }).status, 'noop');
  assert.equal(decide({ ...base, checks: { ...ok, evaluator: { ok: false, code: 1 } }, selection: 'always' }).status, 'rejected');
  assert.equal(decide({ ...base, checks: ok, selection: 'manual' }).status, 'pending');
  assert.equal(decide({ ...base, checks: ok, selection: 'always' }).status, 'accepted');
  const judged = (j) => decide({ ...base, checks: { ...ok, judge: { verdicts: [], regressions: [], score: 0.9, ...j } }, selection: 'judge' });
  assert.equal(judged({ error: 'boom' }).status, 'pending');
  assert.equal(judged({}).status, 'rejected'); // no verdict for r1
  assert.equal(judged({ verdicts: [{ id: 'r1', addressed: true }] }).status, 'accepted');
  assert.equal(judged({ verdicts: [{ id: 'r1', addressed: true }], score: 0.5 }).status, 'rejected');
  assert.equal(judged({ verdicts: [{ id: 'r1', addressed: true }], regressions: [{ id: 'r0', why: 'undoes pnpm' }] }).status, 'rejected');
});

test('looksLikeCorrection catches pushback in English and Korean only at the start', () => {
  for (const p of ['No, use pnpm', "don't add comments", 'I said tabs', '아니 그게 아니라', '그거 말고 다른 방법', '하지마']) assert.ok(looksLikeCorrection(p), p);
  for (const p of ['add a test', 'Is there no way?', '이 파일 고쳐줘', 'Now do the next step']) assert.ok(!looksLikeCorrection(p), p);
});

test('renderTranscript passes a single prompt through and frames a conversation', () => {
  assert.equal(renderTranscript([{ role: 'user', content: 'hi' }]), 'hi');
  assert.match(renderTranscript([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]), /<assistant>\nb\n<\/assistant>[\s\S]*next reply/);
});

test('spliceRulesBlock appends, replaces and removes without touching user text', () => {
  const user = '# Project\n\nMy notes.\n';
  const block = '<!-- atoll:start -->\nR1\n<!-- atoll:end -->';
  const added = spliceRulesBlock(user, block);
  assert.equal(added, `# Project\n\nMy notes.\n\n${block}\n`);
  const withTail = `${added}\n## After\n`;
  const replaced = spliceRulesBlock(withTail, block.replace('R1', 'R2'));
  assert.match(replaced, /My notes\.\n\n<!-- atoll:start -->\nR2\n<!-- atoll:end -->\n\n## After\n$/);
  assert.equal(spliceRulesBlock(replaced, null), '# Project\n\nMy notes.\n\n## After\n');
  assert.equal(spliceRulesBlock(`${block}\n`, null), '');
  assert.equal(spliceRulesBlock(null, null), '');
});

test('mergeHooks replaces only atoll entries', () => {
  const settings = {
    permissions: { allow: ['Bash(ls)'] },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }, { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/atoll/client.mjs" record' }] }],
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR/.claude/atoll/hooks/old.sh"' }] }],
    },
  };
  const merged = mergeHooks(settings, { harness: [{ event: 'PreToolUse', matcher: 'Bash', command: 'bash "$CLAUDE_PROJECT_DIR/.claude/atoll/hooks/new.sh"' }] });
  assert.deepEqual(merged.permissions, settings.permissions);
  assert.equal(merged.hooks.Stop[0].hooks.length, 2, 'own client hooks survive a harness-only merge');
  assert.equal(merged.hooks.PostToolUse, undefined);
  assert.equal(merged.hooks.PreToolUse[0].matcher, 'Bash');
  const cleared = mergeHooks(merged, { own: [], harness: [] });
  assert.deepEqual(cleared.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] });
});

test('lastTurn takes the final real prompt and what the agent did after it', () => {
  const lines = [
    { type: 'user', message: { content: 'first prompt' } },
    { type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'old answer' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'install deps' }] } },
    { type: 'assistant', message: { model: 'claude-y', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm install' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', isMeta: true, message: { content: 'expanded command' } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } },
    { type: 'assistant', message: { model: 'claude-y', content: [{ type: 'text', text: 'Installed.' }] } },
  ];
  const turn = lastTurn(lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.equal(turn.prompt, 'install deps');
  assert.equal(turn.response, 'Installed.');
  assert.deepEqual(turn.tools, [{ name: 'Bash', input: 'npm install' }]);
  assert.equal(turn.model, 'claude-y');
});
