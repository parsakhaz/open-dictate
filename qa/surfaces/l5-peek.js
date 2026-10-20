// L5 · Peek: J13 card, docked view, pointing and crops; J14 its safety (navigation, permissions, allowlist, session).
// Two local servers stand in for a dev server and another site; the agent's working folder is a throwaway folder
// with the pages in it. The pointer and key are the app's QA hooks (`peek pointer on`, `peek press`, `peek say`):
// the OS pointer and keyboard are never touched. See qa/surfaces-journeys.js for ctx.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PAGE = (other) => `<!doctype html><html><head><meta charset="utf-8"><title>Storefront</title>
<style>body{margin:0;font:14px/1.4 system-ui,sans-serif;color:#1b1d22}header{display:flex;gap:16px;align-items:center;padding:10px 20px;border-bottom:1px solid #eee}
h1{font-size:26px;margin:24px 40px 6px}p{margin:0 40px;color:#5b6170}.tiers{display:flex;gap:12px;margin:18px 40px}.tier{flex:1;border:1px solid #e3e5ea;border-radius:10px;padding:12px}
.pay-now{margin:18px 40px;background:#5b4cff;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600}</style></head>
<body><header><b>Storefront</b><a id="out" href="${other}/checkout">Pay with Stripe</a></header>
<h1 class="hero-title">Simple pricing that grows with you</h1><p>Start free, upgrade when your store takes off.</p>
<div class="tiers"><div class="tier">Starter $0</div><div class="tier">Growth $29</div><div class="tier">Scale $99</div></div>
<button class="pay-now">Pay now</button></body></html>`;

function serve(body) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') posts.seen.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body(req));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** The peek QA dump, parsed. */
/** Page loads that were not GETs: a peek's forms never submit. */
const posts = { seen: [] };

const dump = (qa) => qa('peek dump', /QA peek-dump (.+)\n/);

async function until(fn, ok, sleep, tries = 60, ms = 250) {
  let v = null;
  for (let i = 0; i < tries; i++) {
    v = await fn();
    if (ok(v)) return v;
    await sleep(ms);
  }
  return v;
}

let site = null;

async function setUp(OUT) {
  if (site) return site;
  const away = await serve(() => '<!doctype html><title>Checkout</title><h1>Another site</h1>');
  const awayUrl = `http://127.0.0.1:${away.address().port}`;
  const main = await serve((req) => (req.url === '/posted' ? '<h1>posted</h1>' : PAGE(awayUrl)));
  const folder = path.join(OUT, 'peek-site');
  fs.mkdirSync(path.join(folder, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'reports', 'index.html'), '<!doctype html><title>Report</title><h1>Local report</h1><p>Served from the working folder.</p>');
  fs.writeFileSync(path.join(OUT, 'outside.html'), '<h1>outside</h1>');
  site = { url: `http://127.0.0.1:${main.address().port}/`, awayUrl, folder, servers: [main, away] };
  return site;
}

/** An agent's peek call, and the card it raises (wait for the thumbnail), docked with the card's own Peek button. */
async function raiseAndDock(ctx, agent, args) {
  const { qa, sleep, cmd, check } = ctx;
  const call = agent.call('peek', { timeout_s: 120, ...args });
  const d = await until(() => dump(qa), (v) => v?.top?.kind === 'peek' && v.top.title === args.title && !!v.top.data?.thumb, sleep);
  check('the page arrives as a peek card with a live thumbnail', d?.top?.kind === 'peek' && d.top.data.thumb?.width > 100 && !d.docked, d);
  cmd('cards-hover on');
  await sleep(500);
  await qa('card-click Peek', /QA card-click "Peek" (.+)\n/);
  // Docked, and its page loaded (the pointing helper loads with it).
  const docked = await until(() => dump(qa), (v) => v?.docked && v.sheet.kind === 'peek' && !!v.dock?.url && !v.dock.loading, sleep);
  cmd('cards-hover off');
  return { call, docked };
}

module.exports = {
  lane: 'L5',
  journeys: [
    {
      id: 'J13',
      name: 'a peek arrives as a card, grows into the docked view, and pointing returns the element and a crop',
      async run(ctx) {
        const { OUT, session, qa, sleep, cmd, shot, check } = ctx;
        const s = await setUp(OUT);
        const agent = session({ client: 'claude-code', title: 'Claude Code', cwd: s.folder });
        const tools = await agent.list();
        check('the bridge lists peek', tools.includes('peek'), tools);

        const title = 'Does the new pricing page make Growth stand out?';
        const call = agent.call('peek', { title, message: 'Three tiers, Growth in the middle. Point at anything you would change.', target: s.url, ask: 'Does Growth stand out enough?', timeout_s: 120 });
        const card = await until(() => dump(qa), (v) => v?.top?.kind === 'peek' && !!v.top.data?.thumb, sleep);
        check('the card shows a live thumbnail of the page, not the page itself', card?.top?.data?.thumb?.width > 100 && card.top.data.url.startsWith('127.0.0.1:') && !card.docked, card);
        cmd('cards-hover on');
        await sleep(600);
        await shot('l5-warmup');
        await sleep(300);
        await shot('l5-card');
        await qa('card-click Peek', /QA card-click "Peek" (.+)\n/);
        const d = await until(() => dump(qa), (v) => v?.docked && v.sheet.kind === 'peek' && v.dock?.url === s.url, sleep);
        cmd('cards-hover off');
        check('Peek grows it into the docked view above the pill', d?.docked && d.sheet.kind === 'peek' && d.dock.url === s.url, d);
        check('the docked view did not take keyboard focus', d && !d.dock.focused && !d.sheet.focused, d);
        const inside = d && d.dock.bounds.x >= d.sheet.bounds.x && d.dock.bounds.y > d.sheet.bounds.y && d.dock.bounds.x + d.dock.bounds.width <= d.sheet.bounds.x + d.sheet.bounds.width && d.dock.bounds.y + d.dock.bounds.height <= d.sheet.bounds.y + d.sheet.bounds.height;
        check('the page sits inside the sheet, under its header', inside, d);
        await sleep(500);
        await qa('peek shot l5-docked', /QA peek-shot (.+)\n/);

        // Holding the key over the Pay button.
        await qa('peek pointer on', /QA peek-pointer (.+)\n/);
        const pressed = await qa('peek press', /QA peek-press (.+)\n/);
        check('the key held over the page answers this card', pressed?.cardId && pressed.to, pressed);
        await qa('peek hover button.pay-now', /QA peek-hover (.+)\n/);
        await sleep(700);
        await qa('peek shot l5-pointing', /QA peek-shot (.+)\n/);
        await qa('peek say make this button green', /QA peek-say (.+)\n/, 8000);
        await qa('peek pointer off', /QA peek-pointer (.+)\n/);
        const r = (await Promise.race([call, sleep(8000).then(() => null)]))?.result;
        check('the agent gets the words, the URL and the pointed element', r?.answered === true && r.text === 'make this button green' && r.url === s.url && /pay-now/.test(r.pointed?.selector ?? '') && r.pointed?.text === 'Pay now' && r.pointed?.role === 'button', r);
        check('the crop is a PNG file in the captures folder', !!r?.crop && /[\\/]agents[\\/]captures[\\/]peek-.+\.png$/.test(r.crop) && fs.existsSync(r.crop) && fs.readFileSync(r.crop).subarray(1, 4).toString() === 'PNG', r?.crop);
        check('every result carries its card_id', typeof r?.card_id === 'string', r);
        const after = await until(() => dump(qa), (v) => v && !v.docked, sleep, 20);
        check('answered, the card and the docked view go', after && !after.docked && after.cards.length === 0, after);

        // A dragged region waits in the confirm strip for Enter.
        const second = await raiseAndDock(ctx, agent, { title: 'Is the headline too long?', target: s.url });
        check('a second peek docks too', second.docked?.docked, second.docked);
        await qa('peek pointer on', /QA peek-pointer (.+)\n/);
        await qa('peek press', /QA peek-press (.+)\n/);
        await qa('peek drag 30 30 520 110', /QA peek-drag (.+)\n/);
        await sleep(300);
        await qa('peek say make this headline shorter', /QA peek-say (.+)\n/, 8000);
        await qa('peek pointer off', /QA peek-pointer (.+)\n/);
        const c = await until(() => dump(qa), (v) => v?.dock?.confirm, sleep, 20);
        check('a dragged region shows the confirm strip and sends nothing yet', c?.dock?.confirm === true, c);
        const early = await Promise.race([second.call, sleep(500).then(() => null)]);
        check('nothing reaches the agent before Enter', early === null, early);
        await qa('peek shot l5-confirm', /QA peek-shot (.+)\n/);
        await qa('peek key Enter', /QA peek-key (.+)\n/);
        const rr = (await Promise.race([second.call, sleep(6000).then(() => null)]))?.result;
        check('Enter sends the region, its size, the element under it and a crop', rr?.answered === true && rr.text === 'make this headline shorter' && rr.region?.rect?.width === 490 && rr.region?.rect?.height === 80 && /hero-title|h1/.test(rr.region?.under?.selector ?? '') && fs.existsSync(rr.crop ?? ''), rr);
        await sleep(400);
      },
    },
    {
      id: 'J14',
      name: 'a peek stays on its page, gets no permissions, and shows only what the person allowed',
      async run(ctx) {
        const { OUT, session, qa, sleep, check } = ctx;
        const s = await setUp(OUT);
        const agent = session({ client: 'claude-code', title: 'Claude Code', cwd: s.folder });

        // Refused before any card shows.
        const outside = await agent.call('peek', { title: 'x', target: '../outside.html' });
        check('a file outside the working folder is refused', /outside your working folder/.test(outside.error ?? ''), outside);
        const remote = await agent.call('peek', { title: 'x', target: 'https://example.com/' });
        check('an https host off the allowlist is refused', /not on the person's peek list/.test(remote.error ?? ''), remote);
        const file = await agent.call('peek', { title: 'x', target: `file:///${path.join(OUT, 'outside.html').replace(/\\/g, '/')}` });
        check('a file:// URL is refused', /file:\/\//.test(file.error ?? ''), file);
        const plain = await agent.call('peek', { title: 'x', target: 'http://example.com/' });
        check('plain http to another computer is refused', /https only/.test(plain.error ?? ''), plain);

        const { call, docked } = await raiseAndDock(ctx, agent, { title: 'Check the checkout link', target: s.url });
        check('the page docks', docked?.docked, docked);

        // A link to another origin is held at the amber strip.
        await qa('peek click #out', /QA peek-click (.+)\n/);
        const held = await until(() => dump(qa), (v) => v?.dock?.blocked, sleep, 20);
        check('a link to another origin shows the strip and does not navigate', held?.dock?.blocked?.kind === 'navigate' && held.dock.blocked.url.startsWith(s.awayUrl) && held.dock.url === s.url, held);
        await qa('peek shot l5-blocked', /QA peek-shot (.+)\n/);
        await qa('peek action stay', /QA peek-action (.+)\n/);
        const stayed = await dump(qa);
        check('Stay keeps the page', stayed?.dock && !stayed.dock.blocked && stayed.dock.url === s.url, stayed);

        // Allow once, then Back.
        await qa('peek click #out', /QA peek-click (.+)\n/);
        await until(() => dump(qa), (v) => v?.dock?.blocked, sleep, 20);
        await qa('peek action allow', /QA peek-action (.+)\n/);
        const went = await until(() => dump(qa), (v) => v?.dock?.url?.startsWith(s.awayUrl), sleep, 20);
        check('Allow once loads that one address in the peek', went?.dock?.away === true, went);
        await qa('peek action home', /QA peek-action (.+)\n/);
        const back = await until(() => dump(qa), (v) => v?.dock?.url === s.url, sleep, 20);
        check('Back returns to the agent’s page', back?.dock?.url === s.url, back);

        // The page's own script tries what it may not.
        const popup = await qa('peek page popup', /QA peek-page (.+)\n/, 8000);
        check('window.open is denied', popup?.r?.opened === false, popup);
        await qa('peek action stay', /QA peek-action (.+)\n/);
        const perms = await qa('peek page permissions', /QA peek-page (.+)\n/, 10_000);
        check('permission requests are denied', perms?.r && perms.r.notify !== 'granted' && perms.r.geo !== 'granted' && perms.r.mic !== 'granted', perms);
        await qa('peek page post', /QA peek-page (.+)\n/, 8000);
        await sleep(800);
        const posted = await until(() => dump(qa), (v) => v?.dock?.url === s.url, sleep, 20);
        check('a form post never leaves the page', posted?.dock?.url === s.url && !posts.seen.some((p) => p.startsWith('POST /posted')), { posted, posts: posts.seen });

        // The persistent session: a cookie on an allowlisted host reaches the disk; the default session never sees it.
        const cookies = await qa('peek cookies https://rungrain.com/', /QA peek-cookies (.+)\n/, 10_000);
        check('peek keeps its own persistent cookies, written to disk', cookies?.persistent === true && cookies.peek.some((d) => /rungrain\.com$/.test(d)) && cookies.onDisk === true, cookies);
        check('the default browser session is untouched', cookies?.default === 0, cookies);

        // The local report, served from the working folder only.
        await qa('peek action close', /QA peek-action (.+)\n/);
        const closed = (await Promise.race([call, sleep(4000).then(() => null)]))?.result;
        check('✕ ends the peek as dismissed', closed?.answered === false && closed.reason === 'dismissed' && typeof closed.card_id === 'string', closed);
        const report = await raiseAndDock(ctx, agent, { title: 'The test report', target: 'reports/index.html' });
        check('a local .html inside the working folder shows through Dictate’s own protocol', /^dictate-peek:\/\/f[0-9a-f]+\/reports\/index\.html$/.test(report.docked?.dock?.url ?? ''), report.docked);
        await qa('peek action close', /QA peek-action (.+)\n/);
        await Promise.race([report.call, sleep(3000)]);
        for (const srv of s.servers) srv.close();
      },
    },
  ],
};
