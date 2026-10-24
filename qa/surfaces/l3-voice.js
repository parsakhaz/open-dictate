// L3 · Talk to any agent: J10 the agent key to the Voice orchestrator on the test Pane folder (J11 is checked by hand).
// The Pane folder gets a stand-in runpane (l3-fake-runpane.cjs), so no real Pane, Session or tab is touched. With the
// speech model (DICTATE_MODELS_DIR) the words come from the fake mic through the agent key's recording; without it,
// "voice send" hands the route the words a recording would have.
const fakePane = require('./l3-fake-runpane.cjs');
const { ELECTRON } = require('../agent-bridge');

module.exports = {
  lane: 'L3',
  journeys: [
    {
      id: 'J10',
      name: 'the agent key creates the Voice Session, resumes it, sends "[Dictate · voice] …", and its cards read "<agent> · Session / Voice"',
      async run({ PANE_DIR, MODELS, cmd, sleep, qa, log, untilLog, session, cards, shot, check }) {
        fakePane.install(PANE_DIR, { node: ELECTRON, state: { panes: [{ id: 'P1', name: 'Dictate', panels: [{ id: 'T1', title: 'mic-gain', agentType: 'claude' }] }] } });
        cmd('voice recheck');
        const bound = await untilLog(/voice: the agent key talks to the Pane Voice orchestrator/, 5000);
        check('with Pane installed, the agent key is bound to the orchestrator', !!bound);

        // 1. The key with no Sessions yet.
        let mark = log().length;
        let words = 'rerun the mic gain tests with the quiet fixture';
        if (MODELS) {
          cmd('voice down');
          await sleep(2000);
          // What the pill says ("To orchestrator", accent dot) is checked by eye on this shot.
          await shot('l3-agent-key-recording');
          await sleep(2100);
          cmd('voice up');
        } else cmd(`voice send ${words}`);
        const sent = await untilLog(/voice: sent to the orchestrator|voice: not sent/, 60_000, mark);
        await sleep(200);
        let s = fakePane.read(PANE_DIR);
        check('the "Voice" Session was created on the test Pane folder', s.sessions.length === 1 && s.sessions[0].name === 'Voice', s.sessions.map((x) => x.name));
        const panel = s.sessions[0]?.panelIds?.claude;
        check('its chat was resumed before sending', s.calls.some((c) => c[0] === 'panels' && c[1] === 'resume' && c.includes(panel)), s.calls);
        check('the words arrived prefixed "[Dictate · voice]" (delivered:true)', /sent to the orchestrator/.test(sent?.[0] ?? '') && s.sent.length === 1 && s.sent[0].panel === panel && s.sent[0].text.startsWith('[Dictate · voice] ') && (MODELS || s.sent[0].text.endsWith(words)), { sent: s.sent, log: sent?.[0] });
        const status = await qa('voice status', /QA voice status (.+)\n/);
        check('the Session id is kept for next time', status?.session?.id === s.sessions[0]?.id, status);

        // 2. The orchestrator answers through the real bridge, from its Session's chat.
        const orch = session({ client: 'claude-code', title: 'Claude Code', env: { PANE_SESSION_ID: s.sessions[0].internalSessionId, PANE_PANEL_ID: panel } });
        const n = await orch.call('notify', { title: 'Sent to mic-gain', message: 'You said “rerun the mic gain tests”. Sent to **mic-gain** (Claude Code); it will tell you when they finish.' });
        check('notify from the orchestrator shows', n.result?.shown === true || typeof n.result?.card_id === 'string', n);
        let top = null;
        for (let i = 0; i < 30 && !top?.title?.startsWith('Sent to'); i++) {
          top = (await cards())?.top;
          await sleep(200);
        }
        check('its card names the source "<agent> · Session / Voice"', / · Session \/ Voice$/.test(top?.source ?? ''), top);
        cmd('cards-hover on');
        await sleep(700);
        await shot('l3-orchestrator-card');
        cmd('cards-hover off');
        cmd('card dismiss');
        await sleep(400);

        // 3. A draft in the composer: nothing is sent, and the draft card shows.
        s = fakePane.read(PANE_DIR);
        s.panels[panel].draft = true;
        fakePane.write(PANE_DIR, s);
        mark = log().length;
        words = 'and then email me the results';
        cmd(`voice send ${words}`);
        const blocked = await untilLog(/voice: not sent \(draft/, 20_000, mark);
        s = fakePane.read(PANE_DIR);
        check('with text in the composer nothing is sent', !!blocked && s.sent.length === 1, { log: blocked?.[0], sent: s.sent });
        let draft = null;
        for (let i = 0; i < 30 && draft?.kind !== 'voice-draft'; i++) {
          draft = (await cards())?.top;
          await sleep(200);
        }
        check('a "Voice has a draft" card shows, from "<agent> · Session / Voice", with Open', draft?.kind === 'voice-draft' && draft.title === 'Voice has a draft' && / · Session \/ Voice$/.test(draft.source) && draft.target === true, draft);
        cmd('cards-hover on');
        await sleep(700);
        const layout = await qa('card-layout', /QA card-layout (.+)\n/);
        check('the draft card quotes the words and offers Open and Try again', layout && layout.buttons.includes('Open') && layout.buttons.includes('Try again') && layout.text.includes(words), layout);
        await shot('l3-voice-draft');

        // 4. Once the draft is gone, Try again sends the same words and the card goes.
        s = fakePane.read(PANE_DIR);
        s.panels[panel].draft = false;
        fakePane.write(PANE_DIR, s);
        mark = log().length;
        await qa('card-click Try again', /QA card-click "Try again" (.+)\n/);
        await untilLog(/voice: sent to the orchestrator/, 20_000, mark);
        await sleep(400);
        s = fakePane.read(PANE_DIR);
        check('Try again sends the words that were held back', s.sent.length === 2 && s.sent[1].text === `[Dictate · voice] ${words}`, s.sent);
        const after = await cards();
        check('and the draft card goes', after?.top?.kind !== 'voice-draft', after);
        check('only one Session was ever created', s.sessions.length === 1, s.sessions.length);
        cmd('cards-hover off');
        await sleep(300);
      },
    },
  ],
};
