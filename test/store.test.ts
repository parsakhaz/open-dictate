import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadJson, readJson } from '../src/main/store';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadJson', () => {
  it('reads a file saved with a UTF-8 BOM (Notepad, PowerShell)', () => {
    const f = path.join(dir, 'settings.json');
    fs.writeFileSync(f, `﻿${JSON.stringify({ hotkey: [165] })}`);
    expect(loadJson(f, () => undefined)).toEqual({ hotkey: [165] });
    expect(readJson(f)).toEqual({ hotkey: [165] });
  });

  it('is undefined and quiet for a missing file', () => {
    const logs: string[] = [];
    expect(loadJson(path.join(dir, 'nope.json'), (_l, m) => logs.push(m))).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it('logs and keeps a .bad copy of a file it cannot parse, so the next save does not lose it', () => {
    const f = path.join(dir, 'settings.json');
    fs.writeFileSync(f, '{ "hotkey": [165], }');
    const logs: string[] = [];
    expect(loadJson(f, (l, m) => logs.push(`${l} ${m}`))).toBeUndefined();
    expect(fs.readFileSync(`${f}.bad`, 'utf8')).toBe('{ "hotkey": [165], }');
    expect(logs[0]).toMatch(/^warn .*settings\.json.*settings\.json\.bad/);
  });

  it('never overwrites an older .bad copy', () => {
    const f = path.join(dir, 'settings.json');
    fs.writeFileSync(`${f}.bad`, 'first');
    fs.writeFileSync(f, 'second {');
    loadJson(f, () => undefined);
    expect(fs.readFileSync(`${f}.bad`, 'utf8')).toBe('first');
    const copies = fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.bad'));
    expect(copies).toHaveLength(2);
  });
});
