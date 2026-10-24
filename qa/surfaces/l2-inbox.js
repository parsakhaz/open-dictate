// L2 · Inbox, flow guard, round and snooze: J5 flow guard, J6 decision round, J7 snooze, J8 snoozed ask, J10 notify
// replies, J11 how long cards last (order, timeout, Esc with Undo, the earlier list, the pulse), J12 opening a card in
// Pane, J13 the count under a decision sheet. J9 (snooze settings across a restart) is covered by the settings tests,
// and cards across a restart by qa/restart-journey.js; this harness runs one launch.
// Typing is simulated with `inbox keydown` (a key-down's time, as the hook reports it); time for snoozes moves with
// `inbox clock <s>`; round keys and spoken commands go through `inbox key` and `inbox say` (no speech model needed); with the speech model
// the round is also answered by holding the dictation key while the fake mic plays.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fakePane = require('./l3-fake-runpane.cjs');
const { ELECTRON } = require('../agent-bridge');

const INBOX = /QA inbox (\{.*\})\r?\n/;
const PILL = /QA inbox pill (\{.*\})\r?\n/;

async function waitFor(fn, ok, sleep, tries = 40) {
  let v = null;
  for (let i = 0; i < tries; i++) {
    v = await fn();
    if (ok(v)) return v;
    await sleep(200);
  }
  return v;
}

/** Dismisses every card left by an earlier journey. */
async function clear({ cmd, cards, sleep }) {
  for (let i = 0; i < 12; i++) {
    const c = await cards();
    if (!c?.top && !c?.all?.length) return;
    cmd('card dismiss');
    await sleep(150);
  }
}

module.exports = {
  lane: 'L2',
  journeys: [
    {
      id: 'J5',
      name: 'the flow guard holds a card while the person types, then shows it about 6 s later',
      async run(ctx) {
        const { session, cmd, qa, cards, shot, sleep, check } = ctx;
        await clear(ctx);
        const agent = session({ client: 'claude-code', title: 'Claude Code' });
        cmd('inbox keydown');
        await sleep(100);
        const r = await agent.call('notify', { title: 'The nightly backup moved to EU', message: 'Nothing to do.', urgency: 'needs_you' });
        check('notify returns held while the person types', r.result?.status === 'held' && typeof r.result.card_id === 'string', r);
        const d = await qa('inbox dump', INBOX);
        check('no card shows; the badge counts 1 waiting, for typing', d && !d.top && d.extra.waiting === 1 && d.extra.reason === 'typing' && d.focus === 'focused', d);
        const status = await agent.call('status');
        check('status reports focus and waiting', status.result?.focus === 'focused' && status.result.waiting === 1, status.result);
        const pill = await qa('inbox pill none', PILL);
        check('the pill shows "1 waiting"', pill && /1 waiting/.test(pill.strip), pill);
        await shot('l2-j5-waiting');
        const shown = await waitFor(cards, (c) => c?.top?.title === 'The nightly backup moved to EU', sleep, 45);
        check('the card appears about 6 s after the last key-down', shown?.top?.title === 'The nightly backup moved to EU', shown);
        const s = await agent.call('card_status', { card_id: r.result?.card_id });
        check('card_status says shown', s.result?.state === 'shown', s.result);
        await shot('l2-j5-shown');
        cmd('card dismiss');
        const gone = await agent.call('card_status', { card_id: r.result?.card_id });
        await sleep(300);
        const again = await agent.call('card_status', { card_id: r.result?.card_id });
        check('a dismissed card reads dismissed', again.result?.state === 'dismissed', { gone: gone.result, again: again.result });
      },
    },
    {
      id: 'J5r',
      name: "a card replaced by the same session's next notify reads gone, not unknown (#24)",
      async run(ctx) {
        const { session, cmd, cards, sleep, check } = ctx;
        await clear(ctx);
        const agent = session({ client: 'claude-code', title: 'Claude Code' });
        const a = await agent.call('notify', { title: 'A', urgency: 'needs_you' });
        const b = await agent.call('notify', { title: 'B', urgency: 'needs_you' });
        check('the second notify replaces the first', b.result?.status === 'replaced' && b.result.card_id !== a.result?.card_id, { a: a.result, b: b.result });
        const s = await agent.call('card_status', { card_id: a.result?.card_id });
        check('card_status on the replaced card says gone', s.result?.state === 'gone', s.result);
        await waitFor(cards, (c) => c?.top?.title === 'B', sleep);
        cmd('card dismiss');
      },
    },
    {
      id: 'J7',
      name: 'snooze: one button, toast, badge and shelf; the card comes back; each snooze of it is longer, 3 → 5 → 10',
      async run(ctx) {
        const { session, cmd, qa, cards, shot, sleep, check } = ctx;
        await clear(ctx);
        const agent = session({ client: 'codex-mcp-client', title: 'Codex' });
        const r = await agent.call('notify', { title: 'Roll the new checkout out to 10%?', message: 'QA passed in every browser.', urgency: 'needs_you' });
        const id = r.result?.card_id;
        await waitFor(cards, (c) => c?.top?.title === 'Roll the new checkout out to 10%?', sleep);
        cmd('cards-hover on');
        await sleep(500);
        const hovered = await qa('inbox pill none', PILL);
        check('an expanded card carries one Snooze button, for 3 min', hovered && hovered.chips.length === 1 && /Snooze 3 min/.test(hovered.chips[0]), hovered);
        await shot('l2-j7-snooze-button');
        const clicked = await qa('inbox pill snooze', PILL);
        check('clicking it takes the card away', clicked?.clicked === true, clicked);
        cmd('cards-hover off');
        await sleep(400);
        const after = await qa('inbox pill none', PILL);
        check('the toast says "Snoozed 3 min · back at …" and the badge "1 snoozed"', after && /Snoozed 3 min/.test(after.strip) && /back at \d\d:\d\d/.test(after.strip) && /1 snoozed/.test(after.strip), after);
        await shot('l2-j7-toast');
        const s = await agent.call('card_status', { card_id: id });
        check('card_status says snoozed, with until', s.result?.state === 'snoozed' && !Number.isNaN(Date.parse(s.result.until)), s.result);
        const shelf = await qa('inbox pill snoozed', PILL);
        check('the badge opens the shelf with a countdown ring', shelf && shelf.rings === 1 && shelf.shelf.some((t) => /Roll the new checkout/.test(t)), shelf);
        await shot('l2-j7-shelf');
        cmd('inbox clock 300');
        const back = await waitFor(cards, (c) => c?.top?.title === 'Roll the new checkout out to 10%?', sleep);
        const tag = await qa('inbox pill none', PILL);
        check('when time moves on, the card returns, marked "Back from snooze"', back?.top && tag?.back === true, { back, tag });
        await shot('l2-j7-back');
        cmd('cards-hover on');
        await sleep(400);
        const again = await qa('inbox pill none', PILL);
        check('back from its first snooze, its button says 5 min', again && /Snooze 5 min/.test(again.chips[0] ?? ''), again);
        await shot('l2-j7-snooze-again');
        cmd('cards-hover off');
        cmd('inbox shortcut snooze');
        await sleep(300);
        let d = await qa('inbox dump', INBOX);
        check('the shortcut snoozes it for 5 min, its second snooze', d?.toast?.minutes === 5 && !d.top, d);
        cmd('inbox shortcut snooze');
        await sleep(300);
        d = await qa('inbox dump', INBOX);
        check('pressed again while the toast shows, it is 10', d?.toast?.minutes === 10 && d.extra.snoozed.length === 1, d);
        await qa('inbox pill snoozed', PILL);
        const now = await qa(`inbox pill now ${id}`, PILL);
        await sleep(300);
        const nowBack = await cards();
        check('the shelf’s Now brings the card back', now?.clicked === true && nowBack?.top?.title === 'Roll the new checkout out to 10%?', { now, nowBack });
        cmd('cards-hover on');
        await sleep(400);
        const last = await qa('inbox pill none', PILL);
        check('from then on its button stays at 10 min', last && /Snooze 10 min/.test(last.chips[0] ?? ''), last);
        cmd('cards-hover off');
        cmd('card dismiss');
        await sleep(5500);
        d = await qa('inbox dump', INBOX);
        check('with no card up and no toast, the shortcut is not claimed (the key passes through)', d && !d.top && d.claims.snooze === false, d);
      },
    },
    {
      id: 'J8',
      name: 'an ask snoozed past its deadline returns snoozed; a later answer reaches card_status',
      async run(ctx) {
        const { session, cmd, qa, cards, sleep, check } = ctx;
        await clear(ctx);
        const agent = session({ client: 'claude-code', title: 'Claude Code' });
        const ask = agent.call('ask', { question: 'Which region should the backup go to?', choices: ['EU', 'US'], timeout_s: 60 });
        await waitFor(cards, (c) => c?.top?.title === 'Which region should the backup go to?', sleep);
        cmd('inbox snooze 15');
        const r = await Promise.race([ask, sleep(4000).then(() => null)]);
        const res = r?.result;
        check('the ask returns {answered:false, reason:"snoozed", until, card_id}', res?.answered === false && res.reason === 'snoozed' && typeof res.until === 'string' && typeof res.card_id === 'string', r);
        const s = await agent.call('card_status', { card_id: res?.card_id });
        check('card_status says snoozed', s.result?.state === 'snoozed', s.result);
        cmd('inbox clock 900');
        await waitFor(cards, (c) => c?.top?.title === 'Which region should the backup go to?', sleep);
        cmd('card choose EU');
        await sleep(600);
        const late = await agent.call('card_status', { card_id: res?.card_id });
        check('the late answer is in card_status', late.result?.state === 'answered' && late.result.answer?.choice === 'EU', late.result);
        const d = await qa('inbox dump', INBOX);
        check('the card is gone', d && !d.top, d);
      },
    },
    {
      id: 'J10',
      name: 'a notify outside Pane takes a spoken reply, on the pill and in a round, and card_status returns it',
      async run(ctx) {
        const { session, cmd, qa, cards, shot, sheetShot, sleep, check, log, untilLog, MODELS } = ctx;
        await clear(ctx);
        const agent = session({ client: 'claude-code', title: 'Claude Code' });
        const note = { title: 'Tests are red on main. Should I revert?', message: 'The checkout change broke 3 tests. Revert it, or I keep fixing.', urgency: 'needs_you' };
        const n = await agent.call('notify', note);
        await waitFor(cards, (c) => c?.top?.title === note.title, sleep);
        cmd('cards-hover on');
        await sleep(600);
        await shot('l2-j10-notify-hovered');
        const l = await qa('card-layout', /QA card-layout (.+)\n/);
        check('hovered, the notify offers Hold to reply', l?.buttons.includes('Hold to reply'), l);
        cmd('cards-hover off');
        if (MODELS) {
          cmd('card arm-reply');
          await sleep(200);
          const mark = log().length;
          cmd('down');
          await sleep(1500);
          await shot('l2-j10-notify-replying');
          const d = await cards();
          check('while the key is held, the notify stays up, being answered', d?.top?.title === note.title && !!d.replying, d);
          await sleep(2000);
          cmd('up');
          await untilLog(/reply-preview|dictation \d+: final/, 30_000, mark);
          await sleep(400);
          await shot('l2-j10-notify-preview');
          await waitFor(cards, (c) => c?.top?.title !== note.title, sleep, 40);
          const s = await agent.call('card_status', { card_id: n.result?.card_id });
          check('card_status says answered, with the spoken words', s.result?.state === 'answered' && typeof s.result.answer?.text === 'string' && s.result.answer.text.length > 0, s.result);
        } else cmd('card dismiss');

        // In a round, a notify takes a spoken answer the same way.
        cmd('inbox keydown');
        const m = await agent.call('notify', { ...note, title: 'Ship the checkout fix tonight?' });
        await waitFor(() => qa('inbox dump', INBOX), (x) => x?.extra.waiting === 1, sleep, 25);
        cmd('inbox shortcut round');
        await sleep(1000);
        await sheetShot('l2-j10-round-notify');
        const said = await qa('inbox say Yes, ship it tonight', /QA inbox said (\{.*\})\r?\n/);
        check('the round takes the spoken answer for the notify', said?.ok === true, said);
        const d = await qa('inbox dump', INBOX);
        check('the round records it as answered', d?.round === null || d?.round?.results[0] === 'answered', d);
        const summary = await cards();
        check('the summary counts 1 answered', summary?.top?.kind === 'round-summary' && /1 answered/.test(summary.top.title), summary);
        await shot('l2-j10-round-summary');
        // The answer is sent when the summary goes, so Undo could still take it back until then.
        await sleep(9000);
        const s = await agent.call('card_status', { card_id: m.result?.card_id });
        check('card_status says answered, with the words from the round', s.result?.state === 'answered' && s.result.answer?.text === 'Yes, ship it tonight', s.result);

        // The CLI's notify gets the same answer in its request result.
        const cli = (...args) => JSON.parse(execFileSync(ELECTRON, [path.join(ctx.DATA, 'agents', 'dictate-cli.js'), ...args, '--json'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PANE_SESSION_ID: '', PANE_PANEL_ID: '' }, input: JSON.stringify({ ...note, title: 'Roll the fix out to 10%?' }) }).toString());
        cmd('inbox keydown');
        const req = cli('notify', '--from-json', '-');
        await waitFor(() => qa('inbox dump', INBOX), (x) => x?.extra.waiting === 1, sleep, 25);
        cmd('inbox shortcut round');
        await sleep(1000);
        await qa('inbox say Yes, roll it out', /QA inbox said (\{.*\})\r?\n/);
        await sleep(9000);
        const got = cli('request', 'get', req.request_id);
        check('the CLI request result says answered, with the words', got.state === 'answered' && got.result?.text === 'Yes, roll it out', got);
      },
    },
    {
      id: 'J11',
      name: 'cards an agent waits on: first in line, kept after a timeout, Esc with Undo; faded notes go to "earlier"',
      async run(ctx) {
        const { session, cmd, qa, cards, shot, sleep, check, log } = ctx;
        await clear(ctx);
        const builder = session({ client: 'codex-mcp-client', title: 'Codex' });
        const asker = session({ client: 'claude-code', title: 'Claude Code' });
        await builder.call('notify', { title: 'Lint is clean on main', message: 'No warnings in 260 files.' });
        await sleep(300);
        const pulses = (log().match(/QA pulse/g) ?? []).length;
        const ask = asker.call('ask', { question: 'Ship the release notes now?', message: 'They cover 0.2.5 and the restart fix.', choices: ['Ship', 'Wait'], timeout_s: 3 });
        const order = await waitFor(cards, (c) => c?.top?.title === 'Ship the release notes now?', sleep);
        check('the ask goes in front of the info note, which waits behind it in +N', order?.top?.kind === 'ask' && order.more === 1 && JSON.stringify(order.all) === JSON.stringify(['Ship the release notes now?', 'Lint is clean on main']), order);
        check('it arrived with one pulse of the pill', (log().match(/QA pulse/g) ?? []).length === pulses + 1, log().slice(-600));
        await shot('l2-j11-ask-first');
        const r = await Promise.race([ask, sleep(10_000).then(() => null)]);
        check('at timeout_s the agent hears timeout', r?.result?.answered === false && r.result.reason === 'timeout', r);
        const kept = await cards();
        check('and the card stays up', kept?.top?.title === 'Ship the release notes now?', kept);
        const faded = await waitFor(() => qa('inbox pill none', PILL), (p) => /1 earlier/.test(p?.strip ?? ''), sleep, 40);
        check('the faded note leaves "1 earlier" on the pill', /1 earlier/.test(faded?.strip ?? ''), faded);
        const more = await cards();
        check('+N no longer counts the faded note', more?.more === 0, more);
        const list = await qa('inbox pill earlier', PILL);
        check('"1 earlier" opens the note', list?.clicked && list.earlier.some((t) => /Lint is clean on main/.test(t) && /No warnings/.test(t)), list);
        await shot('l2-j11-earlier');
        await qa('inbox pill earlier', PILL);
        cmd('inbox esc');
        await sleep(300);
        let d = await qa('inbox dump', INBOX);
        const toast = await qa('inbox pill none', PILL);
        check('Esc hides the card and shows "Dismissed · Undo"', d && !d.top && d.toast?.kind === 'dismissed' && /Dismissed/.test(toast?.strip ?? '') && /Undo/.test(toast?.strip ?? ''), { d, toast });
        await shot('l2-j11-dismissed');
        await qa('inbox pill undo', PILL);
        const undone = await waitFor(cards, (c) => c?.top?.title === 'Ship the release notes now?', sleep);
        check('Undo brings it back', undone?.top?.title === 'Ship the release notes now?', undone);
        cmd('card choose Ship');
        await sleep(500);
        const late = await asker.call('card_status', { card_id: r?.result?.card_id });
        check('a click after the timeout is a late answer in card_status', late.result?.state === 'answered' && late.result.answer?.choice === 'Ship', late.result);
        const second = asker.call('ask', { question: 'Tag the release too?', choices: ['Tag', 'Skip'], timeout_s: 120 });
        await waitFor(cards, (c) => c?.top?.title === 'Tag the release too?', sleep);
        cmd('inbox esc');
        const gone = await Promise.race([second, sleep(8000).then(() => null)]);
        check('without Undo, the card is dismissed when the toast goes', gone?.result?.answered === false && gone.result.reason === 'dismissed', gone);
      },
    },
    {
      id: 'J12',
      name: 'in Pane, opening a card an agent waits on keeps it; opening an info note ends it',
      async run(ctx) {
        const { PANE_DIR, session, cmd, cards, sleep, check } = ctx;
        await clear(ctx);
        fakePane.install(PANE_DIR, { node: ELECTRON, state: { panes: [{ id: 'P1', name: 'Dictate', panels: [{ id: 'T1', title: 'release', agentType: 'claude' }] }] } });
        const agent = session({ client: 'claude-code', title: 'Claude Code', env: { PANE_SESSION_ID: 'P1', PANE_PANEL_ID: 'T1' } });
        const ask = agent.call('ask', { question: 'Merge the release branch?', choices: ['Merge', 'Wait'], timeout_s: 120 });
        await waitFor(cards, (c) => c?.top?.title === 'Merge the release branch?', sleep);
        cmd('card open');
        await sleep(1500);
        const opened = fakePane.read(PANE_DIR).calls.filter((c) => c[0] === 'links' && c[1] === 'open');
        const still = await cards();
        check('the tab opens and the ask stays', opened.length === 1 && still?.top?.title === 'Merge the release branch?' && still.top.target, { opened, still });
        cmd('card choose Merge');
        const r = await Promise.race([ask, sleep(3000).then(() => null)]);
        check('it still takes its answer', r?.result?.choice === 'Merge', r);
        await agent.call('notify', { title: 'Merged into main', urgency: 'info' });
        await waitFor(cards, (c) => c?.top?.title === 'Merged into main', sleep);
        cmd('card open');
        await sleep(1500);
        const note = await cards();
        check('opening an info note ends it', !note?.all?.includes('Merged into main'), note);
      },
    },
    {
      id: 'J13',
      name: 'while a decision sheet covers the top card, the other waiting cards still count',
      async run(ctx) {
        const { session, cmd, qa, sleep, check, shot } = ctx;
        await clear(ctx);
        const a = session({ client: 'claude-code', title: 'Claude Code' });
        const b = session({ client: 'codex-mcp-client', title: 'Codex' });
        const decide = a.call('decide', { title: 'Where should the backup run?', questions: [{ header: 'Region', question: 'Which region?', options: [{ label: 'EU' }, { label: 'US' }] }], timeout_s: 120 });
        await sleep(800);
        const ask = b.call('ask', { question: 'Rotate the API key now?', choices: ['Rotate', 'Later'], timeout_s: 120 });
        await sleep(800);
        await qa('card-click Expand', /QA card-click "Expand" (.+)\n/);
        await sleep(1200);
        const pill = await qa('inbox pill none', PILL);
        check('the pill shows "1 waiting" under the sheet', /1 waiting/.test(pill?.strip ?? ''), pill);
        await shot('l2-j13-waiting-under-sheet');
        cmd('decide key Escape');
        await sleep(400);
        cmd('card dismiss');
        await sleep(400);
        cmd('card dismiss');
        await Promise.all([decide, ask]);
      },
    },
    {
      id: 'J6',
      name: 'a decision round above the pill: the held key, picks before Enter, decisions and approvals, the summary, Undo, and Esc',
      async run(ctx) {
        const { session, cmd, qa, cards, sheet, shot, sheetShot, sleep, check, log, untilLog, MODELS } = ctx;
        await clear(ctx);
        const agents = [0, 1, 2, 3, 4, 5].map((i) => session({ client: 'codex-mcp-client', title: `Agent ${i}` }));
        const calls = [
          ['ask', { question: 'Where should the coupon field go?', message: 'Four places fit. Most mobile shoppers never scroll past the order summary.', choices: ['Under summary', 'Behind a link', 'Payment step', 'Leave it out'], timeout_s: 120 }],
          ['ask', { question: 'Run the migration on staging?', choices: ['Run it', 'Wait'], timeout_s: 120 }],
          ['ask', { question: 'Restart the worker?', choices: ['Restart it'], timeout_s: 120 }],
          ['decide', { title: 'Two calls before I ship the retry fix', questions: [
            { header: 'Target', question: 'Where should the fix go first?', options: [{ label: 'Staging' }, { label: 'Production' }] },
            { header: 'Policy', question: 'How should failed charges retry?', options: [{ label: 'Backoff ×3' }, { label: 'Once + email' }, { label: "Don't retry" }] },
          ], timeout_s: 120 }],
          ['approve', { title: 'Approve the retry plan', summary: ['Retry failed charges with backoff', 'Email customers after the last retry'], risk: 'medium', timeout_s: 120 }],
          ['ask', { question: 'Review the welcome copy?', choices: ['Looks good', 'Rewrite'], timeout_s: 120 }],
        ];
        // One after another, so the round (oldest first) takes them in this order.
        const asks = [];
        for (const [i, [tool, args]] of calls.entries()) {
          cmd('inbox keydown');
          asks.push(agents[i].call(tool, args));
          await waitFor(() => qa('inbox dump', INBOX), (d) => d?.extra.waiting === i + 1, sleep, 25);
        }
        const held = await qa('inbox dump', INBOX);
        check('six cards wait while the person types', held?.extra.waiting === 6 && !held.top, held);
        await shot('l2-j6-six-waiting');
        // The fake mic plays speech the whole time: a round that listened on its own would hear it.
        const opened = log().length;
        cmd('inbox shortcut round');
        // On a loaded machine the sheet's first dump can be slow: wait for an open one.
        let s = await waitFor(sheet, (x) => x?.open && x.page.kind === 'round', sleep, 25);
        check('the round opens in the sheet, focusable, right above the pill', s?.open && s.kind === 'round' && s.focusable && s.page.kind === 'round', s);
        check('it is 480 px wide (plus its shadow margin) and centred over the pill', s && s.bounds.width === 480 + 24 && Math.abs(s.bounds.x + s.bounds.width / 2 - (s.pill.x + s.pill.width / 2)) <= 1, s?.bounds);
        check('it shows chips and "1 of 6"', s && /1 of 6/.test(s.page.text) && /Where should the coupon field go/.test(s.page.text), s?.page);
        check('outside Pane, each chip names its agent', s && ['Agent 0', 'Agent 1', 'Agent 2', 'Agent 3'].every((a) => s.page.text.includes(a)), s?.page);
        check('with four choices, Enter has no button and the hint asks for a number or an answer', s && /Hold your dictation key and say a number, your answer or/.test(s.page.text) && !/Approve 1/.test(s.page.text), s?.page);
        await sleep(3000);
        let d = await qa('inbox dump', INBOX);
        check('for 4 s after it opens, with speech playing, nothing records and the first card waits', d && !d.listening && d.round?.position.n === 1 && d.round.results.length === 0 && !/capture \d+ on /.test(log().slice(opened)), d);
        check('the pill shows no card during the round', d && !d.top, d);
        cmd('inbox key Enter');
        await sleep(400);
        s = await sheet();
        d = await qa('inbox dump', INBOX);
        check('Enter does not pick choice 1: the round stays and says to pick', d?.round?.position.n === 1 && d.round.results.length === 0 && /Pick 1–4/.test(s?.page.text), { d, text: s?.page.text });
        await sheetShot('l2-j6-round');
        if (MODELS) {
          const mark = log().length;
          cmd('down');
          await sleep(600);
          d = await qa('inbox dump', INBOX);
          check('holding the dictation key records for the round', d?.listening === true && /capture \d+ on /.test(log().slice(mark)), d);
          await sheetShot('l2-j6-round-holding');
          await sleep(3000);
          cmd('up');
          await untilLog(/dictation \d+: (final|nothing heard)/, 30_000, mark);
        } else cmd('inbox say Under the summary, next to the total');
        d = await waitFor(() => qa('inbox dump', INBOX), (x) => x?.round?.position.n === 2, sleep, 25);
        check('the held key answers the first card, and the round moves to "2 of 6"', d?.round?.position.n === 2 && d.round.results[0] === 'answered', d);
        const waited = log().length;
        await sleep(3000);
        d = await qa('inbox dump', INBOX);
        check('the round then waits on the second card without recording', d && !d.listening && d.round?.position.n === 2 && d.round.results.length === 1 && !/capture \d+ on /.test(log().slice(waited)), d);
        cmd('inbox say approve');
        await sleep(600);
        d = await qa('inbox dump', INBOX);
        s = await sheet();
        check('"approve" on a question with two choices picks nothing and says to pick', d?.round?.position.n === 2 && d.round.results.length === 1 && /Pick 1–2/.test(s?.page.text), { d, text: s?.page.text });
        await sheetShot('l2-j6-round-2-pick');
        cmd('inbox key 1');
        await sleep(600);
        const first = await Promise.race([asks[0], sleep(3000).then(() => null)]);
        check('the first answer is sent once the person moves on', first?.result?.answered === true && typeof first.result.text === 'string' && first.result.text.length > 0, first);
        s = await sheet();
        check('a question with one choice names it on the Enter button', s && /3 of 6/.test(s.page.text) && /Restart it\s*Enter/.test(s.page.text), s?.page);
        await sheetShot('l2-j6-round-3-named');
        cmd('inbox key Enter');
        await sleep(600);
        const second = await Promise.race([asks[1], sleep(3000).then(() => null)]);
        check('1 sent "Run it" on the second card', second?.result?.choice === 'Run it', second);
        s = await sheet();
        check('a decision shows its questions and choices', s && /4 of 6/.test(s.page.text) && /Where should the fix go first/.test(s.page.text) && /Once \+ email/.test(s.page.text), s?.page);
        cmd('inbox key Enter');
        await sleep(400);
        d = await qa('inbox dump', INBOX);
        s = await sheet();
        check('Enter does not send a decision with open questions', d?.round?.position.n === 4 && /Pick an answer for every question/.test(s?.page.text), { d, text: s?.page.text });
        cmd('inbox key 1');
        await sleep(400);
        cmd('inbox key 2');
        await sleep(600);
        d = await qa('inbox dump', INBOX);
        check('1 and 2 pick for each question in turn, and the round stays on the decision', d?.round?.position.n === 4 && d.round.results.length === 3, d);
        await sheetShot('l2-j6-round-4-decision');
        cmd('inbox key Enter');
        await sleep(600);
        const third = await Promise.race([asks[2], sleep(3000).then(() => null)]);
        check('Enter sent the named choice of the third card', third?.result?.choice === 'Restart it', third);
        s = await sheet();
        check('an approval shows its plan and an Approve button', s && /5 of 6/.test(s.page.text) && /Retry failed charges with backoff/.test(s.page.text) && /Approve\s*Enter/.test(s.page.text), s?.page);
        await sheetShot('l2-j6-round-5-approve');
        cmd('inbox say approve');
        await sleep(600);
        const fourth = await Promise.race([asks[3], sleep(3000).then(() => null)]);
        check('once every question had a pick, Enter sent the decision', fourth?.result?.answered === true && JSON.stringify(fourth.result.answers?.map((x) => x.picked)) === JSON.stringify([['Staging'], ['Once + email']]), fourth);
        cmd('inbox key s');
        await sleep(800);
        const fifth = await Promise.race([asks[4], sleep(3000).then(() => null)]);
        check('"approve" went through the approval handler', fifth?.result?.approved === true, fifth);
        const closed = await sheet();
        check('after the last card the round closes', closed && !closed.open && !closed.visible, closed);
        d = await qa('inbox dump', INBOX);
        check('focus goes back to the window that had it', d && d.foreground === d.before, d);
        const summary = await cards();
        check('the summary shows the counts', summary?.top?.kind === 'round-summary' && /2 approved, 3 answered, 1 snoozed until \d\d:\d\d/.test(summary.top.title), summary);
        cmd('cards-hover on');
        await sleep(400);
        const rows = await qa('card-layout', /QA card-layout (.+)\n/);
        check('each row shows the question and the answer sent', rows && /Run the migration on staging\?\s*Run it/.test(rows.text) && /Target: Staging · Policy: Once \+ email/.test(rows.text) && /Approve the retry plan\s*Approved/.test(rows.text), rows?.text);
        await shot('l2-j6-summary');
        await sleep(9000);
        const kept = await cards();
        check('the summary stays past 8 s while the pointer is on it', kept?.top?.kind === 'round-summary', kept?.top);
        cmd('cards-hover off');
        cmd('inbox undo');
        // Cards wait a second after a recording ends, then the card is back.
        const undone = await waitFor(cards, (c) => c?.top?.title === 'Review the welcome copy?', sleep, 15);
        check('Undo restores the last card', undone?.top?.title === 'Review the welcome copy?', undone);
        cmd('inbox shortcut round');
        await sleep(800);
        cmd('inbox key Escape');
        await sleep(800);
        const esc = await sheet();
        d = await qa('inbox dump', INBOX);
        check('Esc ends the round', esc && !esc.open && !esc.visible && d && !d.round, { esc, d });
        cmd('card dismiss');
        await sleep(300);
      },
    },
  ],
};
