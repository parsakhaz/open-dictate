// P0 · Seams: nothing the person can see changes. The surface tools stay hidden until their lanes turn them on, a
// card still looks as it did (its CSS now comes from cards.css), and the empty sheet opens right above the pill.
module.exports = {
  lane: 'P0',
  journeys: [
    {
      id: 'J0.1',
      name: 'the bridge lists only the six tools while no lane has turned one on',
      async run({ session, check }) {
        const agent = session({ client: 'claude-code', title: 'Claude Code' });
        const tools = await agent.list();
        check('tools/list is the six built-in tools', JSON.stringify(tools) === JSON.stringify(['notify', 'ask', 'status', 'propose_vocabulary', 'list_vocabulary', 'read_history']), tools);
        const r = await agent.call('decide', { title: 'x', questions: [] });
        check('calling a hidden surface tool is refused', !!r.error || r.result === undefined, r);
        const status = await agent.call('status');
        check('status still answers', status.result?.running === true, status);
      },
    },
    {
      id: 'J0.2',
      name: 'a card looks as it did, drawn by the standard body with cards.css',
      async run({ session, sleep, cmd, qa, shot, check }) {
        const agent = session({ client: 'codex-mcp-client', title: 'Codex' });
        const ask = agent.call('ask', { question: 'Which region should the nightly backup go to?', message: 'Both are ready. EU keeps the data in one place; US is closer to the servers.', choices: ['EU', 'US'], timeout_s: 60 });
        await sleep(900);
        cmd('cards-hover on');
        await sleep(600);
        await shot('p0-card-hovered');
        const l = await qa('card-layout', /QA card-layout (.+)\n/);
        check('the card shows its title, message and choices', l && !l.titleClipped && ['EU', 'US'].every((c) => l.buttons.includes(c)) && l.text.includes('nightly backup'), l);
        check('the card has its styled height (cards.css loaded)', l && l.cardHeight >= 80 && l.cardHeight <= 300, l);
        await qa('card-click EU', /QA card-click "EU" (.+)\n/);
        const answer = await Promise.race([ask, sleep(3000).then(() => null)]);
        check('a click still answers the ask, now with its card_id', answer?.result?.answered === true && answer.result.choice === 'EU' && typeof answer.result.card_id === 'string', answer);
        if (!answer) cmd('card dismiss');
        cmd('cards-hover off');
        await sleep(400);
      },
    },
    {
      id: 'J0.3',
      name: 'the empty sheet opens right above the pill, takes clicks, and Esc closes it',
      async run({ cmd, sleep, sheet, sheetShot, check }) {
        cmd('sheet stub {"title":"Sheet window","note":"The big surfaces open here, right above the pill."}');
        await sleep(900);
        const s = await sheet();
        check('the stub page is open and visible', s?.open && s.kind === 'stub' && s.visible && s.page?.kind === 'stub' && /Sheet window/.test(s.page.text), s);
        check('the sheet can take keyboard focus (the pill cannot)', s?.focusable === true, s);
        const sheetBottom = s && s.bounds.y + s.bounds.height;
        const pillBottom = s && s.pill.y + s.pill.height;
        check('it is centred over the pill, its bottom right above the pill itself', s && Math.abs(s.bounds.x + s.bounds.width / 2 - (s.pill.x + s.pill.width / 2)) <= 1 && sheetBottom < pillBottom && pillBottom - sheetBottom <= 100, s);
        await sheetShot('p0-stub');
        cmd('sheet-close');
        await sleep(400);
        const closed = await sheet();
        check('closing hides it', closed && !closed.open && !closed.visible, closed);
      },
    },
  ],
};
