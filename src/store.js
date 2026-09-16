// State on disk, one directory per scenario:
//
//   <state>/scenarios/<name>/
//     scenario.json        name, recipe settings, created
//     records.jsonl        step 1 · every served or recorded interaction
//     reports.jsonl        step 2 · scores, feedback, asks, implicit corrections
//     candidates/<id>.json step 3 · proposed updates and their evaluation
//     promotions.json      step 4 · executable files the user has promoted
//     artifact/            step 4 · git repository, one tag per published step

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Artifact } from './artifact.js';
import { HttpError, Mutex, now } from './util.js';

export const SCENARIO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {} // a torn last line from a crash is skipped, not fatal
  }
  return out;
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export class Scenario {
  constructor(dir, meta) {
    this.dir = dir;
    this.meta = meta;
    this.name = meta.name;
    this.artifact = new Artifact(join(dir, 'artifact'));
    this.lock = new Mutex();
    this.records = new Map();
    this.reports = new Map();
    this.candidates = new Map();
    this.promotions = {};
    this.lastRecordBySession = new Map();
    this.job = null;
  }

  load() {
    for (const r of readJsonl(join(this.dir, 'records.jsonl'))) {
      this.records.set(r.id, r);
      if (r.session) this.lastRecordBySession.set(r.session, r);
    }
    for (const r of readJsonl(join(this.dir, 'reports.jsonl'))) this.reports.set(r.id, r);
    const cdir = join(this.dir, 'candidates');
    if (existsSync(cdir)) {
      const cands = readdirSync(cdir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(cdir, f), 'utf8')))
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      for (const c of cands) {
        // A job that was running when the process died never finished.
        if (c.status === 'running') {
          c.status = 'failed';
          c.decision = { by: 'system', reason: 'server stopped while the job was running', at: now() };
        }
        this.candidates.set(c.id, c);
      }
    }
    const pfile = join(this.dir, 'promotions.json');
    if (existsSync(pfile)) this.promotions = JSON.parse(readFileSync(pfile, 'utf8'));
    return this;
  }

  addRecord(record) {
    appendFileSync(join(this.dir, 'records.jsonl'), `${JSON.stringify(record)}\n`);
    this.records.set(record.id, record);
    if (record.session) this.lastRecordBySession.set(record.session, record);
    return record;
  }

  addReport(report) {
    appendFileSync(join(this.dir, 'reports.jsonl'), `${JSON.stringify(report)}\n`);
    this.reports.set(report.id, report);
    return report;
  }

  saveCandidate(cand) {
    mkdirSync(join(this.dir, 'candidates'), { recursive: true });
    writeJsonAtomic(join(this.dir, 'candidates', `${cand.id}.json`), cand);
    this.candidates.set(cand.id, cand);
    return cand;
  }

  savePromotions() {
    writeJsonAtomic(join(this.dir, 'promotions.json'), this.promotions);
  }

  saveMeta() {
    writeJsonAtomic(join(this.dir, 'scenario.json'), this.meta);
  }
}

export class Store {
  constructor(root) {
    this.root = root;
    this.dir = join(root, 'scenarios');
    this.scenarios = new Map();
  }

  async open() {
    mkdirSync(this.dir, { recursive: true });
    for (const name of readdirSync(this.dir)) {
      const file = join(this.dir, name, 'scenario.json');
      if (!existsSync(file)) continue;
      const s = new Scenario(join(this.dir, name), JSON.parse(readFileSync(file, 'utf8'))).load();
      await s.artifact.init();
      this.scenarios.set(s.name, s);
    }
    return this;
  }

  get(name) {
    return this.scenarios.get(name);
  }

  require(name) {
    const s = this.scenarios.get(name);
    if (!s) throw new HttpError(404, `scenario "${name}" does not exist`);
    return s;
  }

  #creating = new Mutex();

  create(name, settings = {}) {
    return this.#creating.run(() => this.#create(name, settings));
  }

  async #create(name, settings) {
    if (!SCENARIO_NAME.test(name ?? '')) throw new HttpError(400, 'scenario name must be 1-64 chars of letters, digits, ".", "_" or "-"');
    if (this.scenarios.has(name)) return { scenario: this.scenarios.get(name), created: false };
    const dir = join(this.dir, name);
    mkdirSync(dir, { recursive: true });
    const meta = { name, createdAt: now(), ...settings };
    const s = new Scenario(dir, meta);
    s.saveMeta();
    await s.artifact.init();
    this.scenarios.set(name, s);
    return { scenario: s, created: true };
  }

  async ensure(name) {
    return (await this.create(name)).scenario;
  }
}
