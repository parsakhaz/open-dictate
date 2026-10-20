import { describe, expect, it } from 'vitest';
import { messageLines, plainTitle } from '../src/core/cardtext';

describe('card titles', () => {
  it('drop every Markdown mark and keep the words', () => {
    expect(plainTitle('## **Approve** the `db:migrate` run?')).toBe('Approve the db:migrate run?');
    expect(plainTitle('Read [the plan](https://example.com/plan) _first_')).toBe('Read the plan first');
    expect(plainTitle('- Ship *it*')).toBe('Ship it');
  });

  it('leave snake_case and lone stars alone', () => {
    expect(plainTitle('Rename user_id to account_id')).toBe('Rename user_id to account_id');
    expect(plainTitle('2 * 3 = 6')).toBe('2 * 3 = 6');
  });
});

describe('card messages', () => {
  it('keep bold, italic and inline code as styled runs', () => {
    expect(messageLines('Run **all** tests with `pnpm test`, *carefully*.')).toEqual([
      [{ text: 'Run ' }, { text: 'all', style: 'b' }, { text: ' tests with ' }, { text: 'pnpm test', style: 'code' }, { text: ', ' }, { text: 'carefully', style: 'i' }, { text: '.' }],
    ]);
  });

  it('turn headings, list markers and quotes into plain lines, and links into their text', () => {
    expect(messageLines('# Plan\n- one\n* two\n1. three\n> see [the docs](https://x.dev)')).toEqual([
      [{ text: 'Plan' }],
      [{ text: 'one' }],
      [{ text: 'two' }],
      [{ text: 'three' }],
      [{ text: 'see the docs' }],
    ]);
  });

  it('drop code fences and blank runs, keeping the code lines as code', () => {
    expect(messageLines('Try:\n```sh\npnpm build\n```\n\n\nDone')).toEqual([[{ text: 'Try:' }], [{ text: 'pnpm build', style: 'code' }], [], [{ text: 'Done' }]]);
  });

  it('show markup inside code literally', () => {
    expect(messageLines('use `**not bold**` here')).toEqual([[{ text: 'use ' }, { text: '**not bold**', style: 'code' }, { text: ' here' }]]);
  });

  it('never turns HTML into anything but text', () => {
    const lines = messageLines('<img src=x onerror=alert(1)> **<b>hi</b>**');
    expect(lines).toEqual([[{ text: '<img src=x onerror=alert(1)> ' }, { text: '<b>hi</b>', style: 'b' }]]);
    expect(plainTitle('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});
