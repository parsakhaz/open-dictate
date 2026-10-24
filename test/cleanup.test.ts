import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, EMBERON_GGUF } from '../src/core/settings';
import { Cleanup } from '../src/main/cleanup';

let cleanup: Cleanup | undefined;
afterEach(() => cleanup?.stopAll());

/** An Emberon-only chain whose llama-server and model are not installed yet. */
function uninstalled() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-cleanup-'));
  const settings = { ...defaultSettings(), cleanup: 'emberon' as const, modelsDir: dir, llamaServer: path.join(dir, 'llama-server') };
  cleanup = new Cleanup(settings, 'v3', () => undefined);
  const install = () => {
    fs.writeFileSync(settings.llamaServer, '');
    fs.writeFileSync(path.join(dir, EMBERON_GGUF), '');
  };
  return { c: cleanup, install };
}

describe('Cleanup background check', () => {
  it('starts a server by itself once its llama-server and model appear', () => {
    const { c, install } = uninstalled();
    c.sync();
    expect(c.states().emberon).toBe('stopped');
    c.heal();
    expect(c.states().emberon).toBe('stopped');
    install();
    c.heal();
    expect(c.states().emberon).toBe('starting');
    expect(c.states().gemma).toBe('stopped');
  });

  it('leaves servers alone while they are stopped on purpose, until the next sync', () => {
    const { c, install } = uninstalled();
    install();
    c.stopAll();
    c.heal();
    expect(c.states().emberon).toBe('stopped');
    c.sync();
    expect(c.states().emberon).toBe('starting');
  });
});
