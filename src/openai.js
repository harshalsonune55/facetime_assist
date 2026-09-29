'use strict';

const config = require('./config');

const BASE_URL = 'https://api.openai.com/v1';

// Keep the accepted values explicit even though the current Clue build locks
// the setting to High.
const EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };

/**
 * One streamed answer from the Responses API.
 *
 * `turns` is Clue's neutral history: { role, text, image? }. `on({ delta })`
 * fires for every token; the resolved value is the full text plus usage.
 */
async function streamAnswer({ turns, system, model, effort, signal }, on) {
  const key = config.load().openaiKey;
  if (!key) throw Object.assign(new Error('NO_API_KEY'), { code: 'NO_API_KEY' });

  const body = {
    model,
    stream: true,
    instructions: system,
    input: turns.map(toInput),
    max_output_tokens: 16000,
    // A stable key lets OpenAI reuse the cached prompt prefix across a session.
    prompt_cache_key: 'clue-overlay',
    // The overlay is read mid-conversation: tight answers, not essays.
    text: { verbosity: 'low' },
    // Don't retain the conversation server-side; it is rebuilt from history.
    store: false,
  };
  const level = EFFORT[effort];
  if (level) body.reasoning = { effort: level };

  const res = await fetch(`${BASE_URL}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw await httpError(res);

  let text = '';
  let usage = null;
  let refusal = '';
  let incomplete = '';

  for await (const event of sse(res.body, signal)) {
    switch (event.type) {
      case 'response.output_text.delta':
        if (event.delta) {
          text += event.delta;
          on({ delta: event.delta });
        }
        break;
      case 'response.refusal.delta':
        refusal += event.delta || '';
        break;
      case 'response.completed':
        usage = event.response?.usage || null;
        break;
      case 'response.incomplete':
        usage = event.response?.usage || null;
        incomplete = event.response?.incomplete_details?.reason || 'incomplete';
        break;
      case 'response.failed':
      case 'error': {
        const detail = event.response?.error || event.error || event;
        throw Object.assign(new Error(detail.message || 'The OpenAI API failed mid-answer.'), {
          status: detail.status || 500,
          code: detail.code,
        });
      }
      default:
        break;
    }
  }

  if (!text && refusal) {
    text = `I can't answer that one - ${refusal.trim()}`;
    on({ delta: text });
  }
  if (!text && incomplete === 'max_output_tokens') {
    text = 'That answer hit the length limit before any text came back. Ask for less at once.';
    on({ delta: text });
  }
  return { text, usage };
}

// One history turn -> one Responses API message.
function toInput(turn) {
  if (turn.role === 'assistant') {
    return { role: 'assistant', content: [{ type: 'output_text', text: turn.text }] };
  }
  const content = [];
  if (turn.image) {
    content.push({ type: 'input_image', image_url: `data:image/png;base64,${turn.image}` });
  }
  content.push({ type: 'input_text', text: turn.text });
  return { role: 'user', content };
}

/** Yields each parsed `data:` payload of a server-sent-events stream. */
async function* sse(stream, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    if (signal?.aborted) return;
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    // Events are separated by a blank line; the last piece may be partial.
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload);
        } catch {
          /* a truncated frame is not worth killing the answer over */
        }
      }
    }
  }
}

async function httpError(res, label = 'OpenAI') {
  let message = '';
  let code = '';
  try {
    const json = await res.json();
    message = json?.error?.message || '';
    code = json?.error?.code || '';
  } catch {
    message = await res.text().catch(() => '');
  }
  return Object.assign(new Error(message || `${label} API error ${res.status}`), {
    status: res.status,
    code,
  });
}

/** Human-readable version of whatever went wrong. */
function describe(err) {
  if (err?.code === 'NO_API_KEY') return 'No OpenAI API key set. Press ⌘, to add one.';
  if (err?.code === 'credit_balance_exhausted' || err?.code === 'insufficient_quota') {
    return 'That OpenAI account is out of credits. Add some at platform.openai.com/settings/organization/billing.';
  }
  if (err?.code === 'rate_limit_exceeded') {
    return /per day|RPD/i.test(err.message || '')
      ? 'This OpenAI account is out of requests for today. Add credits at platform.openai.com/settings/organization/billing.'
      : 'Rate limited by the OpenAI API. Wait a moment and ask again.';
  }
  switch (err?.status) {
    case 401:
      return 'That OpenAI API key was rejected. Check it in settings (⌘,).';
    case 403:
      return 'This OpenAI key cannot use that model. Pick another one in settings (⌘,).';
    case 404:
      return 'That model does not exist on this OpenAI account. Pick another one in settings (⌘,).';
    case 429:
      return 'Rate limited by the OpenAI API. Wait a moment and ask again.';
    default:
      if (err?.status >= 500) return 'OpenAI API error. Try again.';
      return err?.message || 'Something went wrong.';
  }
}

module.exports = { streamAnswer, describe };
