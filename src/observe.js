// Step 2 — Observe: validate feedback, match it to recorded interactions, and
// derive each report's lifecycle from the candidates that tried to address it.

import { HttpError, newId, now, truncate } from './util.js';

const MAX_REFS = 100;
const MAX_TEXT = 8_000;

/** POST /atoll/report body. At least one of score or feedback; references are receipts. */
export function validateReport(body, scenario) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'report must be a JSON object');
  const errors = [];
  const { score, feedback } = body;
  const references = body.references ?? [];
  if (score != null && (typeof score !== 'number' || !Number.isFinite(score))) errors.push('score must be a finite number');
  if (feedback != null && typeof feedback !== 'string' && (typeof feedback !== 'object' || Array.isArray(feedback))) {
    errors.push('feedback must be a string or an object');
  }
  if (typeof feedback === 'string' && feedback.length > MAX_TEXT) errors.push(`feedback is longer than ${MAX_TEXT} chars`);
  if (typeof feedback === 'object' && feedback && JSON.stringify(feedback).length > MAX_TEXT * 2) errors.push('feedback object is too large');
  if (score == null && (feedback == null || feedback === '')) errors.push('a report needs a score, feedback, or both');
  if (!Array.isArray(references) || references.some((r) => typeof r !== 'string')) errors.push('references must be an array of receipt ids');
  else if (!references.length) errors.push('references must name at least one receipt (x-atoll-record-id)');
  else if (references.length > MAX_REFS) errors.push(`at most ${MAX_REFS} references`);
  if (errors.length) throw new HttpError(422, 'invalid report', errors);
  const unknown = references.filter((r) => !scenario.records.has(r));
  if (unknown.length) throw new HttpError(422, `unknown receipts for scenario "${scenario.name}"`, unknown);
  return scenario.addReport({
    id: newId('rpt'),
    at: now(),
    kind: 'report',
    score: score ?? null,
    feedback: feedback ?? null,
    references: [...new Set(references)],
    source: typeof body.source === 'string' ? body.source.slice(0, 40) : 'api',
  });
}

/** A plain-language ask for a harness change, not tied to an interaction. */
export function validateAsk(body, scenario) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) throw new HttpError(422, 'ask needs non-empty "text"');
  if (text.length > MAX_TEXT) throw new HttpError(422, `ask is longer than ${MAX_TEXT} chars`);
  return scenario.addReport({
    id: newId('rpt'),
    at: now(),
    kind: 'ask',
    score: null,
    feedback: text,
    references: [],
    source: typeof body.source === 'string' ? body.source.slice(0, 40) : 'api',
  });
}

// A user turn that pushes back on the previous one. Deliberately narrow: it
// only opens an implicit report, and the recipe still decides whether the
// correction reflects a standing preference.
const CORRECTION = [
  /^\s*(no|nope|wrong|not that|that'?s not|that is not|stop|don'?t|do not|never|instead|actually|again|i (said|told you|asked)|why did you|you (forgot|didn'?t|should(n'?t)? have))\b/i,
  /^\s*(아니|아뇨|그게 아니|그거 말고|말고|하지 ?마|하지 ?말|왜 또|다시 해|또 틀|틀렸|잘못|내가 (말했|분명|아까))/,
];

export function looksLikeCorrection(prompt) {
  return typeof prompt === 'string' && CORRECTION.some((re) => re.test(prompt));
}

/** POST /atoll/records — an interaction recorded by a harness hook rather than served by atoll. */
export function ingestRecord(body, scenario, harnessStep) {
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
  const response = typeof body?.response === 'string' ? body.response : '';
  if (!prompt && !response) throw new HttpError(422, 'record needs "prompt" or "response"');
  const session = typeof body.session === 'string' ? body.session.slice(0, 120) : null;
  const previous = session ? scenario.lastRecordBySession.get(session) : null;
  const tools = Array.isArray(body.tools)
    ? body.tools.slice(0, 50).map((t) => ({ name: String(t?.name ?? '').slice(0, 80), input: truncate(String(t?.input ?? ''), 300) }))
    : [];
  const record = scenario.addRecord({
    id: newId('rec'),
    at: now(),
    source: typeof body.source === 'string' ? body.source.slice(0, 40) : 'hook',
    format: 'transcript',
    model: typeof body.model === 'string' ? body.model.slice(0, 120) : null,
    session,
    harnessStep,
    request: { system: '', messages: [{ role: 'user', content: truncate(prompt, 20_000) }] },
    response: { text: truncate(response, 20_000) },
    tools,
    status: 'ok',
  });
  let implicit = null;
  if (previous && looksLikeCorrection(prompt)) {
    implicit = scenario.addReport({
      id: newId('rpt'),
      at: now(),
      kind: 'implicit',
      score: 0,
      feedback: truncate(prompt, 2000),
      references: [previous.id],
      source: 'implicit',
    });
  }
  return { record, implicit };
}

/**
 * Lifecycle of every report, derived from candidates in order:
 *   open → (pending) → addressed | skipped | stale
 * A rejection returns the report to open with the reason attached, until
 * maxAttempts rejections make it stale.
 */
export function reportStates(scenario, { maxAttempts = 2 } = {}) {
  const states = new Map();
  for (const r of scenario.reports.values()) states.set(r.id, { status: 'open', attempts: 0, rejections: [], by: null });
  const cands = [...scenario.candidates.values()].sort((a, b) => a.at.localeCompare(b.at));
  for (const c of cands) {
    for (const s of c.skipped ?? []) {
      const st = states.get(s.id);
      if (st && st.status === 'open') Object.assign(st, { status: 'skipped', by: c.id, why: s.why });
    }
    for (const id of c.addresses ?? []) {
      const st = states.get(id);
      if (!st || st.status === 'addressed') continue;
      if (c.status === 'accepted') Object.assign(st, { status: 'addressed', by: c.id, step: c.step });
      else if (c.status === 'pending' || c.status === 'running') Object.assign(st, { status: 'pending', by: c.id });
      else if (c.status === 'rejected') {
        st.attempts++;
        st.rejections.push({ id: c.id, reason: c.decision?.reason ?? 'rejected' });
        st.status = st.attempts >= maxAttempts ? 'stale' : 'open';
        st.by = c.id;
      } else if (st.status === 'pending' && st.by === c.id) st.status = 'open';
    }
  }
  return states;
}
