// L1 · Decision sheets and approval cards: J1 decide by click, J2 decide by voice, J3 previews open the wide sheet, J4 approve.
// The lane adds its journeys here (and `settings` for its keys); see qa/surfaces-journeys.js for ctx.
// Voice here is `decide say <words>`: the same path a dictation over the card takes after transcription (the 2 s
// preview, then the card's reply), since the test speech model only ever hears its one fixture.

const QUESTIONS = [
  { id: 'env', header: 'Target', question: 'Where should the fix go first?', options: [{ label: 'Staging', description: "Replays last week's 212 failed charges against the fix first." }, { label: 'Production', description: 'Ships to everyone at once.' }] },
  { header: 'Policy', question: 'How should failed charges retry?', options: [{ label: 'Backoff ×3', description: 'Retries at 1 s, 10 s and 60 s, then gives up quietly.' }, { label: 'Once + email', description: 'Retries once after 30 s, then emails the customer a pay link.' }, { label: "Don't retry", description: 'Marks the charge failed and leaves it to support.' }] },
  { header: 'Notify', question: 'Who gets an apology email?', options: [{ label: 'Charged twice' }, { label: 'Charge failed' }, { label: 'Nobody' }], multi: true },
];
const DECIDE = { title: 'Three calls before I ship the retry fix', message: 'Pick one per question, or hold your key and say them all at once.', questions: QUESTIONS, timeout_s: 120 };

const DIFF = (attempts, delays) => `  import { withRetry } from './retry';\n- const policy = { attempts: 1 };\n+ const policy = {\n+   attempts: ${attempts},\n+   delays: [${delays}],\n+ };\n  export async function chargeInvoice(id) {`;
const PREVIEWS = {
  title: 'Three calls before I ship the retry fix',
  questions: [
    { header: 'Policy', question: 'How should failed charges retry?', options: [
      { label: 'Backoff ×3', description: 'Retries at 1 s, 10 s and 60 s, then gives up quietly.', preview: { kind: 'code', content: DIFF(3, "'1s', '10s', '60s'") } },
      { label: 'Once + email', description: 'Retries once after 30 s, then emails a pay link.', preview: { kind: 'code', content: DIFF(1, "'30s'") } },
      { label: "Don't retry", description: 'Marks the charge failed and leaves it to support.', preview: { kind: 'text', content: 'No retry: the charge is marked failed and support sees it in the morning queue.' } },
    ] },
    { header: 'Target', question: 'Where should the fix go first?', options: [{ label: 'Staging' }, { label: 'Production' }] },
  ],
  timeout_s: 120,
};
const PLAN = { title: 'Approve the plan to stop double charges', summary: ['Add an idempotency key to every Stripe charge', 'Retry once after 30 s, then email a pay link', 'Backfill keys for 212 open invoices with a migration', "Ship to staging and replay last week's failures", 'Ask you again before it goes to production'], risk: 'medium', timeout_s: 120 };

/** Waits for the top card to be `title` (a busy machine is slow to start the bridge). */
async function onTop({ cards, sleep }, title) {
  for (let i = 0; i < 50; i++) {
    const c = await cards();
    if (c?.top?.title === title) return c;
    await sleep(200);
  }
  return null;
}

/** This lane's cards and their answers, from the app. */
const dump = ({ qa }) => qa('decide dump', /QA decide (.+)\n/);

/** Clicks a card button by its label, scrolled into view first (a grown card scrolls inside). */
const click = ({ qa }, label) => qa(`decide click ${label}`, /QA decide-click (.+)\n/);

/** A result, or null if the call is still waiting after `ms`. */
const within = (p, sleep, ms) => Promise.race([p, sleep(ms).then(() => null)]);

/** The pill's cards are drawn: a first capture of a fresh window can come back empty. */
async function settle({ sleep, shot }) {
  await sleep(500);
  await shot('l1-warmup');
  await sleep(300);
}

module.exports = {
  lane: 'L1',
  journeys: [
    {
      id: 'J1',
      name: 'decision sheet by click: three questions stacked with chips, Send answers; a timeout returns what was filled',
      async run(ctx) {
        const { session, sleep, cmd, qa, shot, check } = ctx;
        const agent = session({ client: 'claude-code', title: 'Claude Code' });
        const tools = await agent.list();
        check('the bridge lists decide and approve', tools.includes('decide') && tools.includes('approve'), tools);
        const call = agent.call('decide', DECIDE);
        check('the grown card is on top', (await onTop(ctx, DECIDE.title))?.top?.kind === 'decide');
        await settle(ctx);
        const l = await qa('card-layout', /QA card-layout (.+)\n/);
        check('it shows every question, every chip, "0 of 3 answered" and Send', l && ['Staging', 'Production', 'Backoff ×3', 'Once + email', "Don't retry", 'Charged twice', 'Charge failed', 'Nobody'].every((b) => l.text.includes(b)) && l.buttons.includes('Send answers') && /0 of 3 answered/.test(l.text), l);
        await shot('l1-j1-decide-card');
        await click(ctx, 'Staging');
        await click(ctx, 'Once + email');
        await sleep(300);
        let d = await dump(ctx);
        check('two picks show as answered', d?.cards[0]?.data.answers.filter((a) => a.picked.length).length === 2, d);
        await click(ctx, 'Charged twice');
        await click(ctx, 'Charge failed');
        await sleep(400);
        await shot('l1-j1-all-answered');
        const l2 = await qa('card-layout', /QA card-layout (.+)\n/);
        check('the card reads "3 of 3 answered" and "All answered"', l2 && /3 of 3 answered/.test(l2.text) && /All answered/.test(l2.text), l2);
        await click(ctx, 'Send answers');
        const r = (await within(call, sleep, 3000))?.result;
        check('Send returns every answer, by click, with its card_id', r?.answered === true && r.via === 'click' && typeof r.card_id === 'string' && JSON.stringify(r.answers) === JSON.stringify([
          { id: 'env', header: 'Target', picked: ['Staging'] },
          { id: 'q2', header: 'Policy', picked: ['Once + email'] },
          { id: 'q3', header: 'Notify', picked: ['Charged twice', 'Charge failed'] },
        ]), r);

        const short = agent.call('decide', { ...DECIDE, title: 'Two calls, quickly', questions: QUESTIONS.slice(0, 2), timeout_s: 4 });
        await onTop(ctx, 'Two calls, quickly');
        await sleep(300);
        await click(ctx, 'Production');
        const t = (await within(short, sleep, 8000))?.result;
        check('a timeout with one answer returns it as partial', t?.answered === false && t.reason === 'timeout' && t.partial?.length === 1 && t.partial[0].picked[0] === 'Production' && typeof t.card_id === 'string', t);
        d = await dump(ctx);
        check('nothing of this lane is left waiting', d?.cards.length === 0, d);
        cmd('cards-hover off');
      },
    },
    {
      id: 'J2',
      name: 'decision sheet by voice: one sentence fills two questions, the third stays open, Send returns raw',
      async run(ctx) {
        const { session, sleep, qa, shot, check, untilLog, log } = ctx;
        const agent = session({ client: 'codex-mcp-client', title: 'Codex' });
        const call = agent.call('decide', DECIDE);
        await onTop(ctx, DECIDE.title);
        await settle(ctx);
        const mark = log().length;
        ctx.cmd('decide say staging, and once then email');
        await sleep(900);
        await shot('l1-j2-preview');
        const said = await untilLog(/QA decide-said (.+)\n/, 6000, mark);
        const r = said && JSON.parse(said[1]);
        check('after the 2 s preview the card answers "2 of 3 answered"', r?.ok === true && r.message === '2 of 3 answered', r);
        await sleep(150);
        await shot('l1-j2-filled');
        const d = await dump(ctx);
        const a = d?.cards[0]?.data.answers;
        check('staging and once + email are filled by voice, notify stays open', a && a[0].picked[0] === 'Staging' && a[0].via === 'voice' && a[1].picked[0] === 'Once + email' && a[2].picked.length === 0, a);
        check('both filled questions flash', JSON.stringify(d?.cards[0]?.data.flash?.qs) === '[0,1]', d?.cards[0]?.data.flash);
        const l = await qa('card-layout', /QA card-layout (.+)\n/);
        check('the card says by voice and 2 of 3 answered', l && /2 of 3 answered/.test(l.text) && /by voice/.test(l.text), l);
        await click(ctx, 'Send answers');
        const res = (await within(call, sleep, 3000))?.result;
        check('Send returns those answers, the open one empty, plus raw', res?.answered === true && res.raw === 'staging, and once then email' && res.answers[0].picked[0] === 'Staging' && res.answers[1].picked[0] === 'Once + email' && res.answers[2].picked.length === 0, res);

        const all = agent.call('decide', { ...DECIDE, title: 'Say it all' });
        await onTop(ctx, 'Say it all');
        await sleep(300);
        const m2 = log().length;
        ctx.cmd('decide say production, the second one, and nobody');
        const s2 = await untilLog(/QA decide-said (.+)\n/, 6000, m2);
        const r2 = (await within(all, sleep, 3000))?.result;
        check('a sentence that answers every question sends them, by voice', s2 && r2?.answered === true && r2.via === 'voice' && JSON.stringify(r2.answers.map((x) => x.picked)) === JSON.stringify([['Production'], ['Once + email'], ['Nobody']]), r2);
      },
    },
    {
      id: 'J3',
      name: 'previews open the wide sheet: tabs, hover changes only the preview, keys pick and send',
      async run(ctx) {
        const { session, sleep, cmd, sheet, sheetShot, check } = ctx;
        const agent = session({ client: 'claude-code', title: 'Claude Code' });
        const call = agent.call('decide', PREVIEWS);
        await onTop(ctx, PREVIEWS.title);
        let s = null;
        for (let i = 0; i < 20; i++) {
          s = await sheet();
          if (s?.open && s.kind === 'decide' && s.page?.kind === 'decide' && /Previewing/.test(s.page.text)) break;
          await sleep(200);
        }
        check('the 760 px decide sheet opens beside the card, showing the first preview', s?.open && s.kind === 'decide' && s.visible && Math.abs(s.bounds.width - 784) <= 2 && /Previewing\s*1 · Backoff ×3/.test(s.page.text) && /attempts: 3/.test(s.page.text), s);
        check('it has a tab per question', s && /Policy/.test(s.page.text) && /Target/.test(s.page.text) && /not answered/.test(s.page.text), s?.page);
        await sleep(300);
        await sheetShot('l1-j3-sheet');
        cmd('decide hover 1');
        await sleep(400);
        s = await sheet();
        let d = await ctx.qa('decide dump', /QA decide (.+)\n/);
        check('hovering option 2 changes the preview, not the answer', /Previewing\s*2 · Once \+ email/.test(s?.page.text) && /attempts: 1/.test(s?.page.text) && d?.cards[0]?.data.answers[0].picked.length === 0, { text: s?.page.text, answers: d?.cards[0]?.data.answers });
        await sheetShot('l1-j3-hover');
        cmd('decide key Down');
        await sleep(300);
        s = await sheet();
        check('↓ moves the preview on to option 3 (text)', /Previewing\s*3 · Don't retry/.test(s?.page.text), s?.page.text);
        cmd('decide key 1');
        await sleep(500);
        d = await ctx.qa('decide dump', /QA decide (.+)\n/);
        s = await sheet();
        check('the number key picks, by keys, and moves to the next question', d?.cards[0]?.data.answers[0].picked[0] === 'Backoff ×3' && d.cards[0].data.answers[0].via === 'keys' && /Where should the fix go first\?/.test(s?.page.text), { d, text: s?.page.text });
        cmd('decide key Left');
        await sleep(300);
        s = await sheet();
        check('← goes back to the first question', /How should failed charges retry\?/.test(s?.page.text), s?.page.text);
        cmd('decide key Right');
        cmd('decide key 2');
        await sleep(400);
        await sheetShot('l1-j3-answered');
        cmd('decide key Enter');
        const r = (await within(call, sleep, 3000))?.result;
        check('Enter sends, by keys', r?.answered === true && r.via === 'keys' && JSON.stringify(r.answers.map((x) => x.picked)) === JSON.stringify([['Backoff ×3'], ['Production']]), r);
        await sleep(400);
        s = await sheet();
        check('the sheet closes once answered', s && !s.open && !s.visible, s);
      },
    },
    {
      id: 'J4',
      name: 'approve: a click approves; a spoken change shows approval B then returns changes; high risk takes only a click',
      async run(ctx) {
        const { session, sleep, qa, shot, check, log, untilLog } = ctx;
        const agent = session({ client: 'claude-code', title: 'Claude Code' });
        let call = agent.call('approve', PLAN);
        await onTop(ctx, PLAN.title);
        await settle(ctx);
        const l = await qa('card-layout', /QA card-layout (.+)\n/);
        check('approval A: the plan, the medium risk line, Approve and Hold to change', l && /idempotency key/.test(l.text) && /Medium risk/.test(l.text) && l.buttons.includes('Approve') && l.buttons.includes('Hold to change'), l);
        await shot('l1-j4-approval-a');
        await click(ctx, 'Approve');
        let r = (await within(call, sleep, 3000))?.result;
        check('clicking Approve returns approved', r?.approved === true && typeof r.card_id === 'string', r);

        call = agent.call('approve', { ...PLAN, title: 'Approve the retry plan' });
        await onTop(ctx, 'Approve the retry plan');
        await sleep(400);
        const mark = log().length;
        ctx.cmd('decide say Keep the backoff instead of the email, cap it at two retries, and skip the backfill until Monday.');
        await sleep(1000);
        await shot('l1-j4-approval-b');
        const lb = await qa('card-layout', /QA card-layout (.+)\n/);
        check('approval B: "You asked for a change", the quote and the countdown', lb && /You asked for a change/.test(lb.text) && /cap it at two retries/.test(lb.text) && /in 2 s/.test(lb.text), lb);
        await untilLog(/QA decide-said (.+)\n/, 6000, mark);
        r = (await within(call, sleep, 3000))?.result;
        check('after the preview the change goes back with raw', r?.approved === false && /two retries/.test(r.changes) && typeof r.raw === 'string', r);

        call = agent.call('approve', { ...PLAN, title: 'Approve the production migration', risk: 'high' });
        await onTop(ctx, 'Approve the production migration');
        await sleep(400);
        await shot('l1-j4-high-risk');
        const m2 = log().length;
        ctx.cmd('decide say approve');
        const said = await untilLog(/QA decide-said (.+)\n/, 6000, m2);
        const r2 = await within(call, sleep, 1000);
        check('at high risk, saying approve does not approve', said && /only a click approves/.test(said[1]) && r2 === null, { said: said?.[1], r2 });
        await click(ctx, 'Approve');
        r = (await within(call, sleep, 3000))?.result;
        check('a click still approves it', r?.approved === true, r);
      },
    },
  ],
};
