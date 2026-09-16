// A scenario's harness lives in its own git repository. Every accepted update is
// one commit tagged step-N; the history is forward-only (a rollback is a new
// step whose tree equals an older one).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'atoll',
  GIT_AUTHOR_EMAIL: 'atoll@localhost',
  GIT_COMMITTER_NAME: 'atoll',
  GIT_COMMITTER_EMAIL: 'atoll@localhost',
};
// Isolate from the user's global git setup: no signing, no hooks, no templates.
const GIT_FLAGS = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false'];

export class Artifact {
  constructor(dir) {
    this.dir = dir;
  }

  git(args, { input, maxBuffer = 64 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        [...GIT_FLAGS, ...args],
        { cwd: this.dir, env: { ...process.env, ...GIT_ENV }, maxBuffer, encoding: 'buffer' },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`git ${args[0]}: ${stderr.toString() || err.message}`));
          else resolve(stdout);
        },
      );
      if (input != null) child.stdin.end(input);
    });
  }

  async init() {
    mkdirSync(this.dir, { recursive: true });
    if (existsSync(join(this.dir, '.git'))) return;
    await this.git(['init', '-q', '-b', 'main']);
    await this.git(['commit', '-q', '--allow-empty', '-m', 'step 0: empty harness\n\nAtoll-Step: 0']);
    await this.git(['tag', 'step-0']);
  }

  async head() {
    const steps = await this.stepTags();
    const step = steps.length ? steps[steps.length - 1] : 0;
    const sha = (await this.git(['rev-parse', 'HEAD'])).toString().trim();
    return { step, sha };
  }

  async stepTags() {
    const out = (await this.git(['tag', '--list', 'step-*'])).toString();
    return out
      .split('\n')
      .map((t) => Number(t.replace('step-', '')))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b);
  }

  /** Map path -> content for the tree at a step (or HEAD). */
  async files(step) {
    const ref = step == null ? 'HEAD' : `step-${step}`;
    const listing = (await this.git(['ls-tree', '-r', '-z', ref])).toString();
    const entries = listing
      .split('\0')
      .filter(Boolean)
      .map((l) => {
        const [meta, path] = l.split('\t');
        return { sha: meta.split(' ')[2], path };
      });
    const files = new Map();
    if (!entries.length) return files;
    const batch = await this.git(['cat-file', '--batch'], { input: entries.map((e) => e.sha).join('\n') + '\n' });
    let offset = 0;
    for (const e of entries) {
      const nl = batch.indexOf(0x0a, offset);
      const size = Number(batch.subarray(offset, nl).toString().split(' ')[2]);
      files.set(e.path, batch.subarray(nl + 1, nl + 1 + size).toString('utf8'));
      offset = nl + 1 + size + 1;
    }
    return files;
  }

  /** Apply write/delete changes, commit, and tag the next step. */
  async commit(changes, { summary, body = '', trailers = {} }) {
    const { step } = await this.head();
    const next = step + 1;
    // The worktree is atoll's alone; start from exactly the last published tree.
    await this.git(['reset', '-q', '--hard', 'HEAD']);
    await this.git(['clean', '-q', '-fd']);
    for (const c of changes) {
      const abs = join(this.dir, c.path);
      if (c.op === 'delete') rmSync(abs, { force: true });
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, c.content);
      }
    }
    await this.git(['add', '-A']);
    const trailerText = Object.entries({ 'Atoll-Step': next, ...trailers })
      .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\n');
    const message = `step ${next}: ${summary}\n\n${body ? `${body.trim()}\n\n` : ''}${trailerText}\n`;
    await this.git(['commit', '-q', '--allow-empty', '-F', '-'], { input: message });
    await this.git(['tag', `step-${next}`]);
    return this.head();
  }

  async log() {
    const out = (await this.git(['log', '--format=%H%x1f%aI%x1f%B%x1e', '--tags', '--no-walk=sorted'])).toString();
    const tagged = new Map();
    for (const step of await this.stepTags()) {
      const sha = (await this.git(['rev-list', '-n', '1', `step-${step}`])).toString().trim();
      tagged.set(sha, step);
    }
    return out
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sha, at, message] = r.split('\x1f');
        const lines = message.trim().split('\n');
        const trailers = {};
        for (const l of lines) {
          const m = l.match(/^(Atoll-[\w-]+):\s*(.*)$/);
          if (m) trailers[m[1]] = m[2];
        }
        const body = lines
          .slice(1)
          .filter((l) => !/^Atoll-[\w-]+:/.test(l))
          .join('\n')
          .trim();
        return {
          step: tagged.get(sha) ?? Number(trailers['Atoll-Step']),
          sha,
          at: new Date(at).toISOString(), // git prints local offsets; everything else in atoll is UTC
          summary: lines[0].replace(/^step \d+:\s*/, ''),
          body,
          trailers,
        };
      })
      .filter((e) => Number.isInteger(e.step))
      .sort((a, b) => b.step - a.step);
  }

  async diff(step) {
    if (step === 0) return '';
    return (await this.git(['diff', '--no-color', `step-${step - 1}`, `step-${step}`])).toString();
  }

  async changedSince(step) {
    const out = (await this.git(['diff', '--name-only', '-z', `step-${step}`, 'HEAD'])).toString();
    return out.split('\0').filter(Boolean);
  }

  async changedPaths(step) {
    if (step === 0) return [];
    const out = (await this.git(['diff', '--name-only', '-z', `step-${step - 1}`, `step-${step}`])).toString();
    return out.split('\0').filter(Boolean);
  }
}
