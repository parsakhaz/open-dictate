// C1 · Chaos fixes for the pill's cards: dismissing a card always works. A pointer resting on the ✕ keeps it under
// the pointer (#25), main takes clicks wherever the card is drawn while it resizes (#26), and so a click on the ✕
// dismisses the card (#14). The pointer is the app's stand-in (QA "pointer"), in pill page pixels: the OS pointer
// never moves.
const ASK = { message: 'EU is closer to most customers.', choices: ['EU', 'US'], timeout_s: 60 };

/** Asks, and waits for its card to be up and drawn. The agent's answer is `{ answer }`, so awaiting this doesn't wait for it. */
async function askCard({ session, cards, sleep, qa }, question) {
  const agent = session({ client: 'claude-code', title: 'Claude Code' });
  const answer = agent.call('ask', { ...ASK, question });
  for (let i = 0; i < 50 && !(await cards())?.all?.includes(question); i++) await sleep(200);
  for (let i = 0; i < 25 && !(await layout(qa))?.text?.includes('✕'); i++) await sleep(200);
  await sleep(300);
  return { answer };
}

const layout = (qa) => qa('card-layout', /QA card-layout (.+)\n/);
const pointer = (qa, to) => qa(`pointer ${to}`, /QA pointer (.+)\n/);
const click = (qa) => qa('pointer-click', /QA pointer-click (.+)\n/);
const settled = (p, sleep) => Promise.race([p, sleep(3000).then(() => null)]);

/** Whatever a failed check left on the pill goes, so the next journey starts from none. */
async function clear({ cmd, cards, sleep, qa }) {
  await pointer(qa, 'off');
  for (let i = 0; i < 5 && (await cards())?.top; i++) {
    cmd('card dismiss');
    await sleep(300);
  }
}

module.exports = {
  lane: 'C1',
  journeys: [
    {
      id: 'JC.1',
      name: 'a pointer that rests on the ✕ keeps it under the pointer, and the click dismisses the card (#25, #14)',
      async run(ctx) {
        const { qa, sleep, cards, shot, check } = ctx;
        const { answer } = await askCard(ctx, 'Which region should the backup go to?');
        const rest = await pointer(qa, '✕');
        check('the resting card has a ✕', !!rest, rest);
        // A third of a second, then some: the card would have opened and finished growing by now.
        await sleep(700);
        await shot('c1-pointer-on-x');
        const l = await layout(qa);
        check('the card stays as it is while the pointer is on its head: no buttons', l && l.buttons.length === 0, l);
        const hit = await click(qa);
        check('the click lands on the ✕', hit?.hit === 'button ✕', hit);
        await sleep(400);
        const v = await cards();
        check('the card is dismissed', v?.top === null, v);
        const r = await settled(answer, sleep);
        check('the agent hears it was dismissed', r?.result?.answered === false && r.result.reason === 'dismissed', r);
        await clear(ctx);
      },
    },
    {
      id: 'JC.2',
      name: 'the pointer on the body opens the card; its ✕ is clickable throughout the resize, and dismisses it (#26, #14)',
      async run(ctx) {
        const { qa, cmd, sleep, cards, shot, check, log } = ctx;
        const { answer } = await askCard(ctx, 'Which region should the archive go to?');
        const closed = await layout(qa);
        check('the card is up, closed', closed && closed.buttons.length === 0, closed);
        const mark = log().length;
        // The title: the body, below the head.
        const at = await pointer(qa, '.title');
        check('the pointer is on the title', !!at, at);
        // Main's hit area against the ✕, sampled while the card grows (200 ms).
        for (let i = 0; i < 16; i++) {
          cmd('card-hit ✕');
          await sleep(25);
        }
        await sleep(600);
        const samples = [...log().slice(mark).matchAll(/QA card-hit (.+)\n/g)].map((m) => JSON.parse(m[1])).filter((s) => s.at);
        check('the ✕ was inside the hit area at every sample during the resize', samples.length >= 8 && samples.every((s) => s.inside), samples);
        const l = await layout(qa);
        check('the pointer on the body opens the card: its choices show', l && ['EU', 'US'].every((c) => l.buttons.includes(c)), l);
        await shot('c1-open');
        // Up to the ✕ where it now is: the card stays open, and the click dismisses it.
        await pointer(qa, '✕');
        await sleep(400);
        const open = await layout(qa);
        check('the card stays open with the pointer on its head', open && open.buttons.includes('EU'), open);
        const hit = await click(qa);
        check('the click lands on the ✕ of the open card', hit?.hit === 'button ✕', hit);
        await sleep(400);
        const v = await cards();
        check('the open card is dismissed', v?.top === null, v);
        await settled(answer, sleep);
        await clear(ctx);
      },
    },
    {
      id: 'JC.3',
      name: 'with a second card queued, the ✕ dismisses the top one, then the next (#14)',
      async run(ctx) {
        const { qa, sleep, cards, check } = ctx;
        const first = await askCard(ctx, 'Which region should the first backup go to?');
        const second = await askCard(ctx, 'Which region should the second backup go to?');
        const v0 = await cards();
        check('two cards: one on top, one behind', v0?.all?.length === 2, v0);
        for (const n of [1, 2]) {
          await pointer(qa, '✕');
          await sleep(700);
          const hit = await click(qa);
          check(`click ${n} lands on the ✕`, hit?.hit === 'button ✕', hit);
          await sleep(500);
          await pointer(qa, 'off');
          await sleep(200);
        }
        const v = await cards();
        check('both cards are dismissed', v?.top === null && v.all.length === 0, v);
        await settled(Promise.all([first.answer, second.answer]), sleep);
        await clear(ctx);
      },
    },
  ],
};
