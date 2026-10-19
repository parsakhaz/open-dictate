import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testVocabulary } from './vocab';
import { chatRequest, cleanupMaxTokens, fillTemplate, plainText, responseContent } from '../src/core/templating';
import { parseVocabularyFile } from '../src/core/vocabulary';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('fillTemplate', () => {
  const vocab = [
    { term: 'Kubernetes', aliases: ['cube and eighties', 'kubernets'] },
    { term: 'ClickHouse' },
    { term: 'Deepgram', aliases: ['deep gram'] },
  ];

  it('fills lines, inline and sounds-like placeholders, every occurrence', () => {
    const out = fillTemplate('A:\n{{VOCAB_LINES}}\nB: {{VOCAB_INLINE}} / {{VOCAB_INLINE}}\nC:\n{{SOUNDS_LIKE}}', vocab);
    expect(out).toBe(
      'A:\nKubernetes\nClickHouse\nDeepgram\nB: Kubernetes, ClickHouse, Deepgram / Kubernetes, ClickHouse, Deepgram\nC:\ncube and eighties, kubernets => Kubernetes\ndeep gram => Deepgram',
    );
  });

  it('says so when no term has aliases', () => {
    expect(fillTemplate('{{SOUNDS_LIKE}}', [{ term: 'Redis' }, { term: 'JWT', aliases: [] }])).toBe('(no sounds-like pairs yet)');
  });

  it('does not interpret $ patterns in terms', () => {
    expect(fillTemplate('[{{VOCAB_INLINE}}]', [{ term: "$& $1 $'" }])).toBe("[$& $1 $']");
  });

  it('the default vocabulary is the generic tech list, without one person’s own terms (D12)', () => {
    const { terms, error } = parseVocabularyFile(read('defaults/vocabulary.json'));
    expect(error).toBeUndefined();
    const names = terms.map((t) => t.term);
    expect(names).toContain('Kubernetes');
    for (const t of ['Pane', 'Doozy', 'Conductor', 'Claude Code', 'Codex', 'Opus', 'Grain']) expect(names).not.toContain(t);
  });

  it('v3 with added terms carries them and their sounds-like pairs', () => {
    const terms = testVocabulary();
    const filled = fillTemplate(read('defaults/prompt-v3.txt'), terms);
    expect(filled).toContain('UZ, uzi, do see, doozie => Doozy');
    expect(filled).toContain('tri clod, triclod, claude code, club code, clark code, clock code => Claude Code');
    expect(filled).toContain('pain, paint, pane, the pain => Pane');
    for (const t of ['Pane', 'Doozy', 'Conductor', 'Claude Code', 'Codex', 'Opus', 'Grain']) expect(filled).toMatch(new RegExp(`[:,] ${t}(,|$)`, 'm'));
    expect(filled).not.toContain('{{');
  });
});

describe('cleanupMaxTokens', () => {
  it('stays close to the input length', () => {
    expect(cleanupMaxTokens('')).toBe(24);
    expect(cleanupMaxTokens('x'.repeat(100))).toBe(64);
    expect(cleanupMaxTokens('x'.repeat(100000))).toBe(2048);
  });
});

describe('chatRequest', () => {
  it('builds a deterministic, cacheable, non-thinking chat body', () => {
    expect(chatRequest('SYS', 'hello there')).toEqual({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'hello there' },
      ],
      temperature: 0,
      max_tokens: 29,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
    });
  });
});

describe('plainText and responseContent', () => {
  it('strips wrapping quotes and folds newlines', () => {
    expect(plainText('  "Hello there.\n\nGeneral Kenobi."  ')).toBe('Hello there. General Kenobi.');
    expect(plainText('“Quoted”')).toBe('Quoted');
    expect(plainText('He said "hi" to me')).toBe('He said "hi" to me');
  });

  it('reads the first choice, or empty', () => {
    expect(responseContent({ choices: [{ message: { content: 'x' } }] })).toBe('x');
    expect(responseContent({})).toBe('');
  });
});
