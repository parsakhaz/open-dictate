// The agent key's send to the Pane "Voice" orchestrator, through the real PaneLink against a fake runpane on a
// throwaway Pane folder: the Session is found or created once, its chat resumed, a draft stops the send.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PaneLink } from '../src/main/panelink';
import { VoiceOrchestrator } from '../src/main/voiceorch';

// The fake is a CommonJS script, which runpane's shim runs directly.
const fake = createRequire(import.meta.url)('../qa/surfaces/l3-fake-runpane.cjs') as {
  install(paneDir: string, o?: { node?: string; state?: Record<string, unknown> }): void;
  read(paneDir: string): FakeState;
  write(paneDir: string, s: FakeState): void;
};

interface FakeState {
  sessions: { id: string; name: string; agent: string; internalSessionId: string; panelIds: Record<string, string>; archived: boolean; profile?: string; goal?: string }[];
  panels: Record<string, { running: boolean; draft: boolean; startsOnResume?: boolean }>;
  sent: { panel: string; text: string; asFilePointer: boolean }[];
  calls: string[][];
  fail: Record<string, string>;
  panes: unknown[];
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(state: Partial<FakeState> = {}, sessionId: string | null = null) {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-voice-'));
  dirs.push(paneDir);
  fake.install(paneDir, { state });
  const pane = new PaneLink({ paneDir, log: () => undefined, onEvent: () => undefined });
  const saved = { id: sessionId };
  const progress: string[] = [];
  const orch = new VoiceOrchestrator({
    pane,
    sessionId: () => saved.id,
    saveSessionId: (id) => {
      saved.id = id;
    },
    tempDir: path.join(paneDir, 'tmp'),
    log: () => undefined,
    progress: (m) => progress.push(m),
  });
  return { paneDir, pane, orch, saved, progress, state: () => fake.read(paneDir) };
}

const existing = (over: Partial<FakeState['sessions'][number]> = {}) => ({
  id: 'S1',
  name: 'Voice',
  agent: 'claude',
  internalSessionId: 'S1terminal',
  panelIds: { claude: 'S1-claude', codex: 'S1-codex' },
  archived: false,
  ...over,
});

// Each send runs runpane several times as real processes: slow on a busy machine.
describe('VoiceOrchestrator', { timeout: 30_000 }, () => {
  it('creates the Voice Session on first use, resumes its chat and sends the words prefixed', async () => {
    const t = setup();
    const r = await t.orch.send({ text: 'rerun the mic gain tests with the quiet fixture', via: 'voice' });
    expect(r).toEqual({ delivered: true, state: 'taken' });
    const s = t.state();
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].name).toBe('Voice');
    expect(s.sessions[0].profile).toMatch(/\[Dictate · voice\]/);
    expect(s.sessions[0].profile).toMatch(/notify/);
    expect(t.saved.id).toBe(s.sessions[0].id);
    expect(s.sent).toEqual([{ panel: s.sessions[0].panelIds.claude, text: '[Dictate · voice] rerun the mic gain tests with the quiet fixture', asFilePointer: false }]);
    expect(s.calls.some((c) => c[0] === 'panels' && c[1] === 'resume')).toBe(true);
    expect(t.progress).toEqual(['Creating the Voice Session in Pane…', 'Starting the Voice orchestrator…']);
    // The payload file runpane read is gone.
    expect(fs.readdirSync(path.join(t.paneDir, 'tmp'))).toEqual([]);
  });

  it('uses the Session kept in settings, and creates nothing', async () => {
    const t = setup({ sessions: [existing({ id: 'MINE', name: 'Talk', panelIds: { claude: 'M-claude' } })], panels: { 'M-claude': { running: true, draft: false } } }, 'MINE');
    expect(await t.orch.send({ text: 'hi', via: 'voice' })).toEqual({ delivered: true, state: 'taken' });
    const s = t.state();
    expect(s.sessions).toHaveLength(1);
    expect(s.sent[0].panel).toBe('M-claude');
    // Already running: no resume.
    expect(s.calls.some((c) => c[1] === 'resume')).toBe(false);
  });

  it('finds an existing Session named Voice when settings has none, and keeps its id', async () => {
    const t = setup({ sessions: [existing()], panels: { 'S1-claude': { running: true, draft: false } } });
    await t.orch.send({ text: 'hi', via: 'voice' });
    expect(t.saved.id).toBe('S1');
    expect(t.state().sessions).toHaveLength(1);
  });

  it('a kept Session that was archived is replaced by a new one', async () => {
    const t = setup({ sessions: [existing({ archived: true, name: 'Old' })], panels: {} }, 'S1');
    expect((await t.orch.send({ text: 'hi', via: 'voice' })).delivered).toBe(true);
    expect(t.state().sessions).toHaveLength(2);
    expect(t.saved.id).not.toBe('S1');
  });

  it('sends nothing while the composer holds a draft', async () => {
    const t = setup({ sessions: [existing()], panels: { 'S1-claude': { running: true, draft: true } } }, 'S1');
    const r = await t.orch.send({ text: 'hi', via: 'voice' });
    expect(r).toMatchObject({ delivered: false, blocked: 'draft' });
    expect(t.state().sent).toEqual([]);
  });

  it('says not-running when the chat does not start, and sends nothing', async () => {
    const t = setup({ sessions: [existing()], panels: { 'S1-claude': { running: false, draft: false, startsOnResume: false } } }, 'S1');
    expect(await t.orch.send({ text: 'hi', via: 'voice' })).toMatchObject({ delivered: false, blocked: 'not-running' });
    expect(t.state().sent).toEqual([]);
  });

  it('without Pane installed it says so', async () => {
    const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-voice-'));
    dirs.push(paneDir);
    const orch = new VoiceOrchestrator({ pane: new PaneLink({ paneDir, log: () => undefined, onEvent: () => undefined }), sessionId: () => null, saveSessionId: () => undefined, tempDir: paneDir, log: () => undefined });
    expect(orch.available()).toBe(false);
    expect(await orch.send({ text: 'hi', via: 'voice' })).toMatchObject({ delivered: false, blocked: 'pane-missing' });
  });

  it("reports runpane's own error", async () => {
    const t = setup({ fail: { 'sessions list': 'Pane is not running' } });
    expect(await t.orch.send({ text: 'hi', via: 'voice' })).toEqual({ delivered: false, blocked: 'error', message: 'Pane is not running' });
  });

  it('two sends at once create one Session, and both arrive in order', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.orch.send({ text: 'one', via: 'voice' }), t.orch.send({ text: 'two', via: 'point' })]);
    expect(a.delivered && b.delivered).toBe(true);
    const s = t.state();
    expect(s.sessions).toHaveLength(1);
    expect(s.sent.map((x) => x.text)).toEqual(['[Dictate · voice] one', '[Dictate · point] two']);
  });

  it('long text and asFilePointer go as a file pointer', async () => {
    const t = setup({ sessions: [existing()], panels: { 'S1-claude': { running: true, draft: false } } }, 'S1');
    await t.orch.send({ text: 'x'.repeat(2500), via: 'voice' });
    await t.orch.send({ text: 'short', via: 'point', asFilePointer: true });
    expect(t.state().sent.map((x) => x.asFilePointer)).toEqual([true, true]);
  });

  it('forget clears the kept Session: the next send looks again', async () => {
    const t = setup({ sessions: [existing()], panels: { 'S1-claude': { running: true, draft: false } } }, 'S1');
    await t.orch.send({ text: 'hi', via: 'voice' });
    t.orch.forget();
    expect(t.saved.id).toBeNull();
    expect(t.orch.status().session).toBeNull();
  });
});

describe('PaneLink Session names', { timeout: 30_000 }, () => {
  it('a Session chat, which panes list leaves out, reads "Session · <name>"', async () => {
    const t = setup({ panes: [{ id: 'P', name: 'dictate', panels: [] }], sessions: [existing()], panels: {} });
    expect(await t.pane.tabNames('S1terminal', 'S1-claude')).toEqual({ paneId: 'S1terminal', paneName: 'Session', panelTitle: 'Voice' });
    expect(await t.pane.tabNames('nowhere', 'nothing')).toBeNull();
  });
});
