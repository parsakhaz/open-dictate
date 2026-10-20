// L3 · Talk to any agent: hold the agent key (Ctrl+Win) and speak; the words go, after the usual 2 s look, to the
// Pane "Voice" orchestrator (src/main/voiceorch.ts), which routes them and answers on the pill. The same send is
// provided to point and say. A draft in the orchestrator's composer stops the send and shows "Voice has a draft".
import path from 'node:path';
import type { Card } from '../../core/cards';
import { sessionPanel } from '../../core/panewatch';
import { VOICE_SESSION_NAME } from '../../core/voicesession';
import type { OrchestratorResult } from '../orchestrator';
import { VoiceOrchestrator } from '../voiceorch';
import type { Feature, FeatureHost } from './host';

/** What the pill says after a send; words that didn't go stay in History. */
export function pillMessage(r: OrchestratorResult): string {
  if (r.delivered) return r.state === 'queued' ? 'Queued for the orchestrator' : 'Sent to orchestrator';
  switch (r.blocked) {
    case 'pane-missing':
      return 'Pane isn’t installed · not sent';
    case 'draft':
      return 'Voice has a draft · not sent';
    case 'not-running':
      return 'The orchestrator didn’t start · not sent';
    default:
      return `Couldn’t reach Pane · not sent${r.message ? ` (${r.message.slice(0, 80)})` : ''}`;
  }
}

/** How often to look for Pane being installed, so the key starts working without a restart. */
const INSTALL_POLL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | undefined;

export const voice: Feature = {
  name: 'voice',
  setup(host: FeatureHost) {
    const pane = host.agents.pane;
    /** The first send's "Creating…" or "Starting…" toast is up. */
    let progressShown = false;
    const orch = new VoiceOrchestrator({
      pane,
      sessionId: () => host.settings().voice.sessionId,
      saveSessionId: (sessionId) => {
        host.update({ voice: { ...host.settings().voice, sessionId } });
        host.stateChanged();
      },
      tempDir: path.join(host.userData, 'agents', 'tmp'),
      log: host.log,
      progress: (message) => {
        progressShown = true;
        host.pill.send('dictate:pill', { kind: 'toast', message, ms: 60_000 });
      },
    });
    host.provideOrchestrator(orch);

    /** Sends, and on a draft puts up the card that says so. */
    const send = async (text: string): Promise<{ ok: boolean; message: string }> => {
      progressShown = false;
      const r = await orch.send({ text, via: 'voice' });
      // The "Starting…" toast goes; after a recording the pill then says how it went.
      if (progressShown) host.pill.send('dictate:pill', { kind: 'hidden' });
      host.stateChanged();
      if (r.delivered) dropDraft();
      else if (r.blocked === 'draft') showDraft(text);
      return { ok: r.delivered, message: pillMessage(r) };
    };

    const draftKey = 'voice:draft';
    const dropDraft = () => {
      const c = host.hub.queue.byKey(draftKey);
      if (c) host.hub.dismiss(c.id);
    };
    const showDraft = (text: string) => {
      const s = orch.status().session;
      const known = s ? pane.sessions().then((all) => all.find((x) => x.id === s.id)) : Promise.resolve(undefined);
      void known
        .catch(() => undefined)
        .then((found) => {
          const panelId = found ? sessionPanel(found) : null;
          const card: Card = {
            id: host.hub.newId(),
            key: draftKey,
            origin: 'dictate',
            kind: 'voice-draft',
            urgency: 'needs_you',
            source: `Session · ${found?.name || VOICE_SESSION_NAME}`,
            title: 'Voice has a draft',
            message: 'Nothing was sent: its chat already holds text you haven’t sent. Open it to send or clear that, then try again.',
            choices: [],
            data: { text },
            target: found && panelId ? { paneId: found.internalSessionId, panelId } : null,
            createdAt: Date.now(),
          };
          host.hub.raise(card);
        });
    };

    host.hub.cardKind('voice-draft', {
      // Holding the key over the card sends these new words instead, with the same draft check.
      reply: (_card, text) => send(text),
      action: async (card, name) => {
        if (name !== 'retry') return undefined;
        const text = (card.data as { text?: unknown } | undefined)?.text;
        return typeof text === 'string' ? send(text) : undefined;
      },
    });

    const register = () => {
      if (!orch.available()) return false;
      host.route('agent', {
        label: 'To orchestrator',
        finish: 'Release to send to the orchestrator',
        deliver: async (text) => {
          if (!(await host.preview('orchestrator', text))) return { ok: false, message: 'Cancelled · nothing sent' };
          return send(text);
        },
      });
      host.log('info', 'voice: the agent key talks to the Pane Voice orchestrator');
      return true;
    };
    // Without Pane the key stays unbound (it types nothing and takes nothing); it starts working once Pane appears.
    if (!register()) {
      timer = setInterval(() => {
        if (register()) clearInterval(timer);
      }, INSTALL_POLL_MS);
    }

    host.state(() => orch.status());
    host.ipc.handle('forget', () => {
      orch.forget();
      host.stateChanged();
    });
    // QA: "voice down" / "voice up" start and end a recording on the agent key's route (through host.recording, as
    // open listening does; the key hook itself isn't driven); "voice send <words>" delivers as the route would after
    // its preview; "voice status" logs the state.
    host.qa((line) => {
      const [verb, ...rest] = line.split(' ');
      if (verb === 'down') host.recording.start('agent');
      else if (verb === 'up') host.recording.stop();
      else if (verb === 'send') void send(rest.join(' ')).then((r) => host.log('info', `QA voice sent ${JSON.stringify(r)}`));
      else if (verb === 'status') host.log('info', `QA voice status ${JSON.stringify(orch.status())}`);
      else if (verb === 'forget') orch.forget();
      // Look for Pane now rather than at the next poll (the journeys install a test runpane after start).
      else if (verb === 'recheck' && timer && register()) clearInterval(timer);
    });
  },
  stop() {
    clearInterval(timer);
  },
};
