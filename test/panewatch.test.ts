import { describe, expect, it } from 'vitest';
import { actionFor, backoffMs, clientSourceLine, paneLink, paneSourceLine, parseWatchLine, runpaneLaunch, watchArgs } from '../src/core/panewatch';

const SHIM = `@echo off
rem pane-managed-runpane-shim v1: Pane rewrites this file at startup; edits are lost.
setlocal
if not defined PANE_DIR set "PANE_DIR=C:\\Users\\me\\.pane"
set ELECTRON_RUN_AS_NODE=1
"C:\\Program Files\\Pane\\Pane.exe" "C:\\Users\\me\\.pane\\bin\\runpane.cjs" %*
`;

describe('runpaneLaunch', () => {
  it("runs Pane's executable directly on Windows, never through cmd.exe", () => {
    const l = runpaneLaunch('C:\\Users\\me\\.pane', 'win32', (f) => (f.endsWith('runpane.cmd') ? SHIM : null));
    expect(l).toEqual({ file: 'C:\\Program Files\\Pane\\Pane.exe', args: ['C:\\Users\\me\\.pane\\bin\\runpane.cjs'], env: { PANE_DIR: 'C:\\Users\\me\\.pane', ELECTRON_RUN_AS_NODE: '1' } });
  });

  it('runs the shell shim elsewhere, and reports a missing CLI', () => {
    expect(runpaneLaunch('/home/me/.pane', 'linux', () => '#!/bin/sh')).toEqual({ file: '/home/me/.pane/bin/runpane', args: [], env: { PANE_DIR: '/home/me/.pane' } });
    expect(runpaneLaunch('/home/me/.pane', 'darwin', () => null)).toBeNull();
    expect(runpaneLaunch('C:\\p', 'win32', () => '@echo off\r\nsomething else %*')).toBeNull();
  });
});

describe('the watch', () => {
  it('follows blocked, ready, busy and reports under its own cursor, with short settles and no batching', () => {
    const a = watchArgs();
    expect(a.slice(0, 7)).toEqual(['watch', '--follow', '--as', 'dictate', '--from', 'now', '--json']);
    expect(a[a.indexOf('--kinds') + 1].split(',')).toEqual(expect.arrayContaining(['agent.blocked', 'agent.ready', 'agent.busy', 'agent.report']));
    expect(a[a.indexOf('--blocked-settle') + 1]).toBe('5000');
    expect(a[a.indexOf('--min-interval') + 1]).toBe('0');
  });

  const attached = Date.parse('2026-10-19T20:00:00Z');
  const line = (o: object) => JSON.stringify({ gen: 1, at: '2026-10-19T20:00:05Z', paneId: 'P', paneName: 'dictate-mcp', panelId: 'T', panelTitle: 'Codex', agentType: 'codex', ...o });

  it('skips resets, the start-up snapshot and events from before it attached', () => {
    expect(parseWatchLine('{"kind":"_reset","reason":"cursor-truncated"}', attached)).toBeNull();
    expect(parseWatchLine(line({ kind: 'agent.blocked', baseline: true, replay: true }), attached)).toBeNull();
    expect(parseWatchLine(line({ kind: 'agent.blocked', at: '2026-10-19T19:00:00Z' }), attached)).toBeNull();
    expect(parseWatchLine('HEARTBEAT', attached)).toBeNull();
    expect(parseWatchLine(line({ kind: 'agent.blocked' }), attached)).toMatchObject({ kind: 'agent.blocked', paneName: 'dictate-mcp', panelId: 'T' });
  });

  it('maps events to what the pill does', () => {
    const ev = (o: object) => parseWatchLine(line(o), attached)!;
    expect(actionFor(ev({ kind: 'agent.blocked' }))).toEqual({ type: 'blocked', paneId: 'P', panelId: 'T' });
    expect(actionFor(ev({ kind: 'agent.ready' }))).toEqual({ type: 'finished', paneId: 'P', panelId: 'T' });
    expect(actionFor(ev({ kind: 'agent.busy' }))).toEqual({ type: 'clear', paneId: 'P', panelId: 'T' });
    expect(actionFor(ev({ kind: 'pane.gone', panelId: undefined }))).toEqual({ type: 'clear-pane', paneId: 'P' });
  });

  it("uses a report's question as the title and its summary as the message", () => {
    const e = parseWatchLine(line({ kind: 'agent.report', report: { state: 'blocked', question: 'Drop the old column?', summary: 'Migration 42 is ready.' } }), attached)!;
    expect(actionFor(e)).toEqual({ type: 'blocked', paneId: 'P', panelId: 'T', title: 'Drop the old column?', message: 'Migration 42 is ready.' });
    const done = parseWatchLine(line({ kind: 'agent.report', report: { state: 'done', summary: 'Opened PR 7.' } }), attached)!;
    expect(actionFor(done)).toMatchObject({ type: 'finished', title: 'Finished', message: 'Opened PR 7.' });
  });
});

describe('source lines', () => {
  it('name the agent, then the repo and the Pane', () => {
    expect(paneSourceLine({ paneName: 'P0 No-reply mode', repoName: 'bloom-mono', agentType: 'claude' })).toBe('Claude · bloom-mono / P0 No-reply mode');
    expect(paneSourceLine({ paneName: 'open-dictate', repoName: 'open-dictate', agentType: 'codex' })).toBe('Codex · open-dictate');
    expect(paneSourceLine({ paneName: 'dictate-mcp' }, { name: 'cursor-vscode' })).toBe('Cursor · dictate-mcp');
    expect(paneSourceLine({ paneName: '' })).toBe('Agent · Pane tab');
  });

  it('name the agent and its folder outside Pane, with the repo for a worktree', () => {
    expect(clientSourceLine({ name: 'cursor-vscode' }, 'C:\\repos\\open-dictate')).toBe('Cursor · open-dictate');
    expect(clientSourceLine({ name: 'claude-code', title: 'Claude Code' }, '/Users/me/repos/open-dictate/worktrees/card-readability')).toBe('Claude · open-dictate / card-readability');
    expect(clientSourceLine({ name: 'gemini-cli', title: 'Gemini CLI' }, '/home/me/app/')).toBe('Gemini CLI · app');
  });
});

it('links to exactly one tab', () => {
  expect(paneLink('a b', 'c&d')).toBe('pane://open?pane=a%20b&panel=c%26d');
});

it('backs off to at most a minute', () => {
  expect([1, 2, 3, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 60_000]);
});
