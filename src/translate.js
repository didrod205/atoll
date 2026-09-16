// Provider formats <-> one canonical conversation.
//
// canonical request:  { model, system, messages: [{ role: 'user'|'assistant', content: string }], maxTokens, temperature, stream }
// canonical response: { text, model, stopReason: 'end'|'max_tokens', usage: { input, output } }
//
// Translation is text-only. When the client speaks the upstream's own format the
// server forwards the raw body instead, so tools and images survive untouched.

import { HttpError, newId } from './util.js';

function pushMessage(messages, role, content) {
  if (!content) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role) last.content += `\n\n${content}`;
  else messages.push({ role, content });
}

function openaiText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p?.type === 'text' ? p.text : p?.type === 'image_url' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

export function fromOpenAI(body) {
  if (!body || !Array.isArray(body.messages)) throw new HttpError(400, 'messages must be an array');
  const system = [];
  const messages = [];
  for (const m of body.messages) {
    const text = openaiText(m?.content);
    if (m?.role === 'system' || m?.role === 'developer') system.push(text);
    else if (m?.role === 'user') pushMessage(messages, 'user', text);
    else if (m?.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((c) => `[tool call ${c.function?.name}] ${c.function?.arguments ?? ''}`);
      pushMessage(messages, 'assistant', [text, ...calls].filter(Boolean).join('\n'));
    } else if (m?.role === 'tool') pushMessage(messages, 'user', `[tool result]\n${text}`);
  }
  return {
    model: body.model,
    system: system.filter(Boolean).join('\n\n'),
    messages,
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    temperature: body.temperature,
    stream: !!body.stream,
  };
}

function anthropicBlocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      switch (b?.type) {
        case 'text':
          return b.text;
        case 'tool_use':
          return `[tool call ${b.name}] ${JSON.stringify(b.input ?? {})}`;
        case 'tool_result':
          return `[tool result]\n${anthropicBlocksText(b.content)}`;
        case 'image':
          return '[image]';
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

export function fromAnthropic(body) {
  if (!body || !Array.isArray(body.messages)) throw new HttpError(400, 'messages must be an array');
  const messages = [];
  for (const m of body.messages) {
    if (m?.role === 'user' || m?.role === 'assistant') pushMessage(messages, m.role, anthropicBlocksText(m.content));
  }
  return {
    model: body.model,
    system: anthropicBlocksText(body.system ?? ''),
    messages,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    stream: !!body.stream,
  };
}

export const fromFormat = (format, body) => (format === 'anthropic' ? fromAnthropic(body) : fromOpenAI(body));

export function toOpenAIRequest(c, model) {
  const messages = [];
  if (c.system) messages.push({ role: 'system', content: c.system });
  messages.push(...c.messages);
  const body = { model, messages };
  if (c.maxTokens != null) body.max_tokens = c.maxTokens;
  if (c.temperature != null) body.temperature = c.temperature;
  return body;
}

export function toAnthropicRequest(c, model) {
  const body = { model, max_tokens: c.maxTokens ?? 4096, messages: c.messages };
  if (c.system) body.system = c.system;
  if (c.temperature != null) body.temperature = c.temperature;
  return body;
}

export function parseOpenAIResponse(json) {
  const choice = json?.choices?.[0];
  return {
    text: openaiText(choice?.message?.content) ?? '',
    model: json?.model,
    stopReason: choice?.finish_reason === 'length' ? 'max_tokens' : 'end',
    usage: { input: json?.usage?.prompt_tokens ?? 0, output: json?.usage?.completion_tokens ?? 0 },
  };
}

export function parseAnthropicResponse(json) {
  return {
    text: (json?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
    model: json?.model,
    stopReason: json?.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
    usage: { input: json?.usage?.input_tokens ?? 0, output: json?.usage?.output_tokens ?? 0 },
  };
}

export function toOpenAIResponse(r, model) {
  return {
    id: `chatcmpl-${newId('x').slice(2)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: r.model ?? model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: r.text },
        finish_reason: r.stopReason === 'max_tokens' ? 'length' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: r.usage.input,
      completion_tokens: r.usage.output,
      total_tokens: r.usage.input + r.usage.output,
    },
  };
}

export function toAnthropicResponse(r, model) {
  return {
    id: `msg_${newId('x').slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: r.model ?? model,
    content: [{ type: 'text', text: r.text }],
    stop_reason: r.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: r.usage.input, output_tokens: r.usage.output },
  };
}

export const toFormatResponse = (format, r, model) =>
  format === 'anthropic' ? toAnthropicResponse(r, model) : toOpenAIResponse(r, model);

const sse = (event, data) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

/** A complete response replayed as a provider-shaped SSE stream. */
export function toFormatStream(format, r, model) {
  if (format === 'anthropic') {
    const msg = toAnthropicResponse(r, model);
    return [
      sse('message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: r.usage.input, output_tokens: 0 } } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: r.text } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: r.usage.output } }),
      sse('message_stop', { type: 'message_stop' }),
    ].join('');
  }
  const base = toOpenAIResponse(r, model);
  const chunk = (delta, finish) => ({
    id: base.id,
    object: 'chat.completion.chunk',
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    sse(null, chunk({ role: 'assistant', content: '' }, null)),
    sse(null, chunk({ content: r.text }, null)),
    sse(null, { ...chunk({}, base.choices[0].finish_reason), usage: base.usage }),
    sse(null, '[DONE]'),
  ].join('');
}

/** Accumulates the assistant text out of an upstream SSE stream as it passes through. */
export function streamCollector(format) {
  let buffer = '';
  let text = '';
  const usage = { input: 0, output: 0 };
  let model;
  const line = (l) => {
    if (!l.startsWith('data:')) return;
    const payload = l.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      return;
    }
    if (format === 'anthropic') {
      if (ev.type === 'message_start') {
        model = ev.message?.model;
        usage.input = ev.message?.usage?.input_tokens ?? 0;
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text;
      else if (ev.type === 'message_delta') usage.output = ev.usage?.output_tokens ?? usage.output;
    } else {
      model ??= ev.model;
      const d = ev.choices?.[0]?.delta?.content;
      if (typeof d === 'string') text += d;
      if (ev.usage) {
        usage.input = ev.usage.prompt_tokens ?? usage.input;
        usage.output = ev.usage.completion_tokens ?? usage.output;
      }
    }
  };
  return {
    push(chunk) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, nl).replace(/\r$/, ''));
        buffer = buffer.slice(nl + 1);
      }
    },
    result() {
      if (buffer) line(buffer);
      buffer = '';
      return { text, model, stopReason: 'end', usage };
    },
  };
}
