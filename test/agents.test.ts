// Settings → Agents → "Show Pane's agent alerts on the pill" decides whether Dictate runs its Pane watch at all.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../src/core/settings';
import type { Settings } from '../src/core/types';
import { Agents, type AgentsHost } from '../src/main/agents';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function agents(over: Partial<Settings>) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-agents-'));
  dirs.push(userData);
  let settings: Settings = { ...defaultSettings(), ...over };
  const host = {
    userData,
    appRoot: userData,
    log: () => undefined,
    settings: () => settings,
    update: (patch: Partial<Settings>) => {
      settings = { ...settings, ...patch };
    },
    showCards: () => undefined,
    paneInFront: () => false,
    registration: { allowed: false, executable: process.execPath, env: { HOME: userData, USERPROFILE: userData, APPDATA: userData } },
  } as unknown as AgentsHost;
  const a = new Agents(host);
  const start = vi.spyOn(a.pane, 'start').mockImplementation(() => undefined);
  const stop = vi.spyOn(a.pane, 'stop').mockImplementation(() => undefined);
  return { a, start, stop, set: (patch: Partial<Settings>) => host.update(patch) };
}

describe("Pane's alerts on the pill", () => {
  it("doesn't start the Pane watch when Dictate starts with the setting off, but does with it on", async () => {
    for (const on of [false, true]) {
      const { a, start } = agents({ agentPaneAlerts: on });
      await a.start();
      expect(start).toHaveBeenCalledTimes(on ? 1 : 0);
      a.stop();
    }
  });

  it('runs no Pane watch when the setting is off (the default)', () => {
    const { a, start, stop } = agents({});
    a.applyPaneWatch();
    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it('follows Pane once the person turns it on, and stops again when they turn it off', () => {
    const { a, start, stop, set } = agents({ agentPaneAlerts: true });
    a.applyPaneWatch();
    expect(start).toHaveBeenCalledTimes(1);
    set({ agentPaneAlerts: false });
    a.applyPaneWatch();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
