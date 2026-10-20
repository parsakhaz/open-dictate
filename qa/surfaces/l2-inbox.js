// L2 · Inbox, flow guard, round and snooze: J5 flow guard, J6 decision round, J7 snooze, J8 snoozed ask.
// J9 (snooze settings across a restart) is covered by the settings tests; this harness runs one launch.
// Typing is simulated with `inbox keydown` (a key-down's time, as the hook reports it); time for snoozes moves with
// `inbox clock <s>`; round keys and spoken commands go through `inbox key` and `inbox say` (no speech model needed).

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
      id: 'J7',
      name: 'snooze: chips, toast, badge and shelf; the card comes back; the shortcut steps 3 → 5',
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
        check('an expanded card carries the snooze chips 3m 5m 10m', hovered && JSON.stringify(hovered.chips) === JSON.stringify(['3m', '5m', '10m']), hovered);
        await shot('l2-j7-chips');
        const clicked = await qa('inbox pill chip 5', PILL);
        check('clicking 5m takes the card away', clicked?.clicked === true, clicked);
        cmd('cards-hover off');
        await sleep(400);
        const after = await qa('inbox pill none', PILL);
        check('the toast says "Snoozed 5 min · back at …" and the badge "1 snoozed"', after && /Snoozed 5 min/.test(after.strip) && /back at \d\d:\d\d/.test(after.strip) && /1 snoozed/.test(after.strip), after);
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
        cmd('inbox shortcut snooze');
        await sleep(300);
        let d = await qa('inbox dump', INBOX);
        check('the shortcut snoozes the top card for 3 min', d?.toast?.minutes === 3 && !d.top, d);
        cmd('inbox shortcut snooze');
        await sleep(300);
        d = await qa('inbox dump', INBOX);
        check('pressed again while the toast shows, it is 5', d?.toast?.minutes === 5 && d.extra.snoozed.length === 1, d);
        await qa('inbox pill snoozed', PILL);
        const now = await qa(`inbox pill now ${id}`, PILL);
        await sleep(300);
        const nowBack = await cards();
        check('the shelf’s Now brings the card back', now?.clicked === true && nowBack?.top?.title === 'Roll the new checkout out to 10%?', { now, nowBack });
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
      id: 'J6',
      name: 'a decision round above the pill: keys, open listening, the summary, Undo, and Esc',
      async run(ctx) {
        const { session, cmd, qa, cards, sheet, shot, sheetShot, sleep, check, MODELS } = ctx;
        await clear(ctx);
        const agents = [0, 1, 2].map((i) => session({ client: 'codex-mcp-client', title: `Agent ${i}` }));
        const questions = [
          { question: 'Where should the coupon field go?', message: 'Four places fit. Most mobile shoppers never scroll past the order summary.', choices: ['Under summary', 'Behind a link', 'Payment step', 'Leave it out'], timeout_s: 120 },
          { question: 'Run the migration on staging?', choices: ['Run it', 'Wait'], timeout_s: 120 },
          { question: 'Review the welcome copy?', choices: ['Looks good', 'Rewrite'], timeout_s: 120 },
        ];
        // One after another, so the round (oldest first) takes them in this order.
        const asks = [];
        for (const [i, q] of questions.entries()) {
          cmd('inbox keydown');
          asks.push(agents[i].call('ask', q));
          await waitFor(() => qa('inbox dump', INBOX), (d) => d?.extra.waiting === i + 1, sleep, 25);
        }
        const held = await qa('inbox dump', INBOX);
        check('three cards wait while the person types', held?.extra.waiting === 3 && !held.top, held);
        await shot('l2-j6-three-waiting');
        cmd('inbox shortcut round');
        await sleep(1000);
        const s = await sheet();
        check('the round opens in the sheet, focusable, right above the pill', s?.open && s.kind === 'round' && s.focusable && s.page.kind === 'round', s);
        check('it is 480 px wide (plus its shadow margin) and centred over the pill', s && s.bounds.width === 480 + 24 && Math.abs(s.bounds.x + s.bounds.width / 2 - (s.pill.x + s.pill.width / 2)) <= 1, s?.bounds);
        check('it shows chips and "1 of 3"', s && /1 of 3/.test(s.page.text) && /Where should the coupon field go/.test(s.page.text), s?.page);
        let d = await qa('inbox dump', INBOX);
        // Without the speech model the mic can't open (the pill says the model is loading); the round still listens for keys.
        check('open listening is on while the round is open', d?.listening === true && (d.recording === true || !MODELS), d);
        check('the pill shows no card during the round', d && !d.top, d);
        await sheetShot('l2-j6-round');
        cmd('inbox key 2');
        await sleep(500);
        d = await qa('inbox dump', INBOX);
        check('2 answers the first card, and the round moves to "2 of 3"', d?.round?.position.n === 2 && d.round.results[0] === 'answered', d);
        cmd('inbox say approve');
        await sleep(600);
        const first = await Promise.race([asks[0], sleep(3000).then(() => null)]);
        check('the first answer is sent once the person moves on', first?.result?.answered === true && first.result.choice === 'Behind a link', first);
        d = await qa('inbox dump', INBOX);
        check('saying "approve" approves the second card', d?.round?.results[1] === 'approved' && d.round.position.n === 3, d);
        await sheetShot('l2-j6-round-3');
        cmd('inbox key s');
        await sleep(800);
        const second = await Promise.race([asks[1], sleep(3000).then(() => null)]);
        check('S snoozes the last card; the approval before it is sent', second?.result?.choice === 'Run it', second);
        const closed = await sheet();
        check('after the last card the round closes', closed && !closed.open && !closed.visible, closed);
        d = await qa('inbox dump', INBOX);
        check('open listening stopped with the round', d && !d.listening && !d.recording, d);
        check('focus goes back to the window that had it', d && d.foreground === d.before, d);
        const summary = await cards();
        check('the summary shows the counts', summary?.top?.kind === 'round-summary' && /1 approved, 1 answered, 1 snoozed until \d\d:\d\d/.test(summary.top.title), summary);
        await shot('l2-j6-summary');
        cmd('inbox undo');
        await sleep(500);
        const undone = await cards();
        check('Undo restores the last card', undone?.top?.title === 'Review the welcome copy?', undone);
        cmd('inbox shortcut round');
        await sleep(800);
        // Esc with the mic open goes through the key hook; without the model there is no recording, so the page's Esc.
        cmd(MODELS ? 'escape' : 'inbox key Escape');
        await sleep(800);
        const esc = await sheet();
        d = await qa('inbox dump', INBOX);
        check('Esc ends the round and open listening', esc && !esc.open && d && !d.round && !d.listening, { esc, d });
        cmd('card dismiss');
        await sleep(300);
      },
    },
  ],
};
