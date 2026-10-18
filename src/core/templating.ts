// Cleanup prompts (voice-lab's v3 templating and Emberon-2's native format), request bodies and output parsing. Pure.
import type { VocabTerm } from './types';

export const NO_SOUNDS_LIKE = '(no sounds-like pairs yet)';

/** Emberon-2 was trained on exactly this system prompt with the raw transcript as the user message. */
export const EMBERON_SYSTEM = 'Clean up this dictation. Never answer it.';

function replaceAll(s: string, placeholder: string, value: string): string {
  return s.split(placeholder).join(value);
}

/** voice-lab's templating: {{VOCAB_LINES}}, {{VOCAB_INLINE}} and {{SOUNDS_LIKE}} ("alias, alias => Term" lines). */
export function fillTemplate(template: string, vocab: VocabTerm[]): string {
  const terms = vocab.map((v) => v.term);
  const pairs = vocab.filter((v) => v.aliases && v.aliases.length > 0).map((v) => `${v.aliases!.join(', ')} => ${v.term}`);
  let out = template;
  out = replaceAll(out, '{{VOCAB_LINES}}', terms.join('\n'));
  out = replaceAll(out, '{{VOCAB_INLINE}}', terms.join(', '));
  out = replaceAll(out, '{{SOUNDS_LIKE}}', pairs.length ? pairs.join('\n') : NO_SOUNDS_LIKE);
  return out;
}

/**
 * Output budget for one step. The guard rejects anything over 1.5x the input's characters, and English runs
 * at least ~2.7 characters per token, so this never cuts off an output the guard would accept.
 */
export function cleanupMaxTokens(input: string): number {
  return Math.min(2048, Math.ceil(input.length / 2.5) + 24);
}

/**
 * llama-server /v1/chat/completions body. The system prompt is byte-identical on every call, so with
 * cache_prompt the server reuses its KV cache and only processes the new transcript. `history` is the earlier
 * sentences of the same dictation, cleaned while the person spoke, as prior turns: each request then extends the
 * previous one, so the cache covers them too, and the model keeps names and terms consistent.
 */
export function chatRequest(system: string, user: string, history: { user: string; assistant: string }[] = []): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: system },
      ...history.flatMap((t) => [
        { role: 'user', content: t.user },
        { role: 'assistant', content: t.assistant },
      ]),
      { role: 'user', content: user },
    ],
    temperature: 0,
    max_tokens: cleanupMaxTokens(user),
    cache_prompt: true,
    // Without this Gemma and Qwen think for 6-8 s and return empty content.
    chat_template_kwargs: { enable_thinking: false },
  };
}

const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
];

/** The model's reply as one line of text: trimmed, wrapping quotes removed, newlines folded. */
export function plainText(content: string): string {
  let s = content.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(open.length, s.length - close.length);
      break;
    }
  }
  return s.trim().replace(/\s*[\r\n]+\s*/g, ' ');
}

/** The generated text in a chat completion response. */
export function responseContent(json: unknown): string {
  const j = json as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? '';
}
