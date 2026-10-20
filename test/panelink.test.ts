// PaneLink against a fake runpane: the tab names on an agent's card stay current when no watch is running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PaneLink } from '../src/main/panelink';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A Pane folder whose runpane answers `panes list` and `panels list` from title.txt. */
function fakePane(): { paneDir: string; setTitle(t: string): void } {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-pane-'));
  dirs.push(paneDir);
  const bin = path.join(paneDir, 'bin');
  fs.mkdirSync(bin);
  const titleFile = path.join(paneDir, 'title.txt');
  const script = path.join(bin, 'runpane.js');
  fs.writeFileSync(
    script,
    `const fs = require('node:fs');
const a = process.argv.slice(2);
const title = fs.readFileSync(${JSON.stringify(titleFile)}, 'utf8');
if (a[0] === 'panes') console.log(JSON.stringify({ panes: [{ id: 'P', name: 'dictate' }] }));
else if (a[0] === 'panels') console.log(JSON.stringify({ panels: [{ id: 'X', title, agentType: 'codex' }] }));
else console.log(JSON.stringify({ ok: false, error: { message: 'unknown' } }));
`,
  );
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'runpane.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  else {
    fs.writeFileSync(path.join(bin, 'runpane'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(path.join(bin, 'runpane'), 0o755);
  }
  const setTitle = (t: string) => fs.writeFileSync(titleFile, t);
  setTitle('Build');
  return { paneDir, setTitle };
}

describe('PaneLink tab names', () => {
  it('looks a tab up again each time while no watch runs, so a renamed tab shows its new name', async () => {
    const pane = fakePane();
    const link = new PaneLink({ paneDir: pane.paneDir, log: () => undefined, onEvent: () => undefined });
    expect((await link.tabNames('P', 'X'))?.panelTitle).toBe('Build');
    pane.setTitle('Release');
    expect((await link.tabNames('P', 'X'))?.panelTitle).toBe('Release');
  });
});
