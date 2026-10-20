// L4 · Lineup: J12 grid, picks in order, lightbox, refused paths and sizes, an SVG's script never runs.
// The agent's working folder is tmp/surfaces-journeys/lineup-work, with four PNGs written here; keys and clicks reach
// the sheet page through the feature's QA commands (`lineup key|click|dump|say|open`).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** A 640×400 mock "hero": a background, a headline bar, a button and the candidate's number as blocks. */
function png([r, g, b], [r2, g2, b2], n) {
  const W = 640;
  const H = 400;
  const rows = [];
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(1 + W * 3);
    for (let x = 0; x < W; x++) {
      const bar = y > 90 && y < 130 && x > 60 && x < 420;
      const bar2 = y > 145 && y < 165 && x > 60 && x < 300;
      const btn = y > 200 && y < 240 && x > 60 && x < 200;
      const dot = y > 260 && y < 360 && x > 440 && x < 440 + n * 36 && (x - 440) % 36 < 26;
      const on = bar || bar2 || btn || dot;
      row[1 + x * 3] = on ? r2 : r;
      row[2 + x * 3] = on ? g2 : g;
      row[3 + x * 3] = on ? b2 : b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const HEROES = [
  { id: 'a', label: 'Centred', caption: 'Big headline over the three best sellers', colors: [[19, 32, 61], [255, 181, 76]] },
  { id: 'b', label: 'Split', caption: 'Email sign-up beside the bag', colors: [[243, 234, 223], [217, 119, 74]] },
  { id: 'c', label: 'Photo', caption: 'Full-bleed morning scene, one button', colors: [[90, 52, 32], [239, 230, 220]] },
  { id: 'd', label: 'Bold type', caption: 'Loud yellow, ships-Monday sticker', colors: [[255, 216, 77], [17, 17, 17]] },
];

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" onload="parent.document.body.dataset.pwned='onload'">
<script>try { top.document.title = 'pwned'; parent.document.body.dataset.pwned = 'script'; } catch (e) {}</script>
<rect width="640" height="400" fill="#1f6f4a"/><rect x="60" y="90" width="360" height="40" rx="6" fill="#7ee0b0"/>
<circle cx="500" cy="260" r="70" fill="#0f201a"/></svg>`;

function folders(OUT) {
  const work = path.join(OUT, 'lineup-work');
  const outside = path.join(OUT, 'lineup-outside');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  HEROES.forEach((x, i) => fs.writeFileSync(path.join(work, `hero-${x.id}.png`), png(x.colors[0], x.colors[1], i + 1)));
  fs.writeFileSync(path.join(outside, 'elsewhere.png'), png([60, 60, 60], [200, 200, 200], 1));
  const big = path.join(work, 'huge.png');
  fs.writeFileSync(big, png([0, 0, 0], [255, 255, 255], 1));
  fs.truncateSync(big, 10 * 1024 * 1024 + 1024);
  fs.writeFileSync(path.join(work, 'scripted.svg'), SVG);
  return { work, outside };
}

const heroes = (work) => HEROES.map((x) => ({ id: x.id, label: x.label, caption: x.caption, image: path.join(work, `hero-${x.id}.png`) }));

async function until(fn, ok, sleep, tries = 50) {
  let v = null;
  for (let i = 0; i < tries; i++) {
    v = await fn();
    if (ok(v)) return v;
    await sleep(200);
  }
  return v;
}

module.exports = {
  lane: 'L4',
  journeys: [
    {
      id: 'J12.1',
      name: 'four PNGs line up in the grid; 2, 4, Enter returns b then d; the lightbox pages with H and the arrows',
      async run({ OUT, session, sleep, cmd, qa, cards, sheet, shot, sheetShot, check }) {
        const { work } = folders(OUT);
        const agent = session({ client: 'claude-code', title: 'Claude Code', cwd: work });
        const tools = await agent.list();
        check('the bridge lists lineup', tools.includes('lineup'), tools);
        const call = agent.call('lineup', { title: 'Pick a hero for the new homepage', message: 'Four directions from the brief.', candidates: heroes(work) });
        const c = await until(cards, (v) => v?.top?.kind === 'lineup', sleep);
        check('a needs-you lineup card shows', c?.top?.kind === 'lineup' && c.top.urgency === 'needs_you' && c.top.title === 'Pick a hero for the new homepage', c);
        cmd('cards-hover on');
        await sleep(900);
        const tiles = await until(() => qa('lineup card', /QA lineup card (.+)\n/), (v) => v?.tiles?.length === 4 && v.tiles.every((t) => t.drawn), sleep);
        check('the card shows a strip of four drawn thumbnails', tiles?.tiles?.length === 4 && tiles.tiles.every((t) => t.drawn), tiles);
        await shot('l4-warmup');
        await sleep(300);
        await shot('l4-card');
        const click = await qa('card-click Open lineup', /QA card-click "Open lineup" (.+)\n/);
        check('the card offers Open lineup', !!click, click);
        const s = await until(sheet, (v) => v?.kind === 'lineup' && v.visible, sleep);
        check('Open lineup opens the lineup sheet', s?.kind === 'lineup' && s.visible && /Pick a hero/.test(s.page?.text ?? ''), s);
        const dump = () => qa('lineup dump', /QA lineup (\{.+)\n/);
        const grid = await until(dump, (v) => v?.images?.length === 4 && v.images.every((i) => i.loaded), sleep);
        check('the grid shows the four images, loaded as image data', grid?.mode === 'grid' && grid.images.length === 4 && grid.images.every((i) => i.loaded && i.type === 'image/png;bas'), grid);
        await sleep(300);
        await sheetShot('l4-grid');
        cmd('lineup key 2');
        cmd('lineup key 4');
        await sleep(400);
        const starred = await dump();
        check('2 then 4 star b then d, marked 1st and 2nd', JSON.stringify(starred?.picks) === '[1,3]' && JSON.stringify(starred?.ranks) === '["1st","2nd"]' && starred?.send === 'Send (2)', starred);
        await sheetShot('l4-starred');
        cmd('lineup click Open full size');
        await sleep(400);
        const box = await dump();
        check('Open full size shows the lightbox at the last starred', box?.mode === 'box' && box.index === 3 && /4 \/ 4/.test(box.text) && /Shortlist/.test(box.text), box);
        cmd('lineup key ArrowLeft');
        cmd('lineup key h');
        await sleep(400);
        const hearted = await dump();
        check('← moves to 3 and H adds it to the shortlist', hearted?.index === 2 && JSON.stringify(hearted.picks) === '[1,3,2]', hearted);
        await sheetShot('l4-lightbox');
        cmd('lineup key H');
        cmd('lineup key ArrowRight');
        await sleep(300);
        const back = await dump();
        check('H again takes it out; → moves on', back?.index === 3 && JSON.stringify(back.picks) === '[1,3]', back);
        cmd('lineup key Escape');
        await sleep(300);
        const out = await dump();
        const still = await sheet();
        check('Esc steps out of the lightbox to the grid, the sheet stays', out?.mode === 'grid' && still?.open && still.kind === 'lineup', { out, still });
        cmd('lineup key Enter');
        const r = await Promise.race([call, sleep(5000).then(() => null)]);
        check('Enter returns picks ["b","d"] in that order, ranked, with the card id', r?.result?.answered === true && JSON.stringify(r.result.picks) === '["b","d"]' && r.result.ranked === true && typeof r.result.card_id === 'string', r);
        await sleep(500);
        const closed = await sheet();
        const after = await cards();
        check('the sheet closes and the card goes', closed && !closed.open && !after?.top, { closed, after });
        cmd('cards-hover off');
      },
    },
    {
      id: 'J12.2',
      name: 'an image outside the folder, an over-size file, a remote URL and a URL candidate are refused with a tool error',
      async run({ OUT, session, sleep, cards, check }) {
        const { work, outside } = folders(OUT);
        const agent = session({ client: 'claude-code', title: 'Claude Code', cwd: work });
        const base = heroes(work).slice(0, 1);
        const cases = [
          ['outside the folder', { id: 'x', label: 'Elsewhere', image: path.join(outside, 'elsewhere.png') }, /outside your working folder/],
          ['through ..', { id: 'x', label: 'Elsewhere', image: '../lineup-outside/elsewhere.png' }, /outside your working folder/],
          ['over 10 MB', { id: 'x', label: 'Huge', image: path.join(work, 'huge.png') }, /over 10 MB/],
          ['a remote URL', { id: 'x', label: 'Remote', image: 'https://example.com/hero.png' }, /local files, not URLs/],
          ['a URL candidate', { id: 'x', label: 'Page', url: 'http://localhost:5173/hero' }, /URL candidates/],
        ];
        for (const [what, cand, re] of cases) {
          const r = await agent.call('lineup', { title: 'Pick one', candidates: [...base, cand] });
          check(`${what} is refused with a tool error`, typeof r.error === 'string' && re.test(r.error), r);
        }
        await sleep(300);
        const c = await cards();
        check('no card was raised', !c?.top, c);
      },
    },
    {
      id: 'J12.3',
      name: "an SVG with a script shows as an image and the script never runs; None of these returns a no",
      async run({ OUT, session, sleep, cmd, qa, cards, sheet, sheetShot, check }) {
        const { work } = folders(OUT);
        const agent = session({ client: 'codex-mcp-client', title: 'Codex', cwd: work });
        const call = agent.call('lineup', {
          title: 'Which empty state?',
          candidates: [
            { id: 'svg', label: 'Illustrated', caption: 'An SVG with a script in it', image: path.join(work, 'scripted.svg') },
            { id: 'copy', label: 'Words only', text: 'Nothing here yet.\nAdd your first roast to see it on the shelf.' },
            { id: 'a', label: 'Centred', image: path.join(work, 'hero-a.png') },
          ],
          pick: 'one',
        });
        await until(cards, (v) => v?.top?.kind === 'lineup', sleep);
        cmd('lineup open');
        await until(sheet, (v) => v?.kind === 'lineup' && v.visible, sleep);
        const dump = () => qa('lineup dump', /QA lineup (\{.+)\n/);
        const d = await until(dump, (v) => v?.images?.length === 2 && v.images.every((i) => i.loaded), sleep);
        await sleep(800);
        const later = await dump();
        check('the SVG shows as an image', d?.images?.some((i) => i.type === 'image/svg+xml' && i.loaded), d);
        check('its script and onload never ran (no mark on the page, title unchanged)', later && later.pwned === null && later.title !== 'pwned', later);
        check('the text candidate shows as text', /Add your first roast/.test(later?.text ?? ''), later);
        await sheetShot('l4-svg-text');
        cmd('lineup key 3');
        cmd('lineup key 1');
        await sleep(300);
        const one = await dump();
        check('with pick "one", a second number replaces the first', JSON.stringify(one?.picks) === '[0]' && JSON.stringify(one?.ranks) === '["Pick"]', one);
        cmd('lineup click None of these');
        const r = await Promise.race([call, sleep(5000).then(() => null)]);
        check('None of these returns answered with no picks', r?.result?.answered === true && r.result.none === true && r.result.picks.length === 0, r);
      },
    },
    {
      id: 'J12.4',
      name: 'one spoken sentence picks in order and keeps the rest as a comment',
      async run({ OUT, session, sleep, cmd, qa, cards, check }) {
        const { work } = folders(OUT);
        const agent = session({ client: 'claude-code', title: 'Claude Code', cwd: work });
        const call = agent.call('lineup', { title: 'Pick a hero', candidates: heroes(work) });
        await until(cards, (v) => v?.top?.kind === 'lineup', sleep);
        const miss = await qa('lineup say they all look the same', /QA lineup say (.+)\n/);
        check('words with no picks leave the lineup waiting', miss && miss.ok === false && /Say the numbers/.test(miss.message), miss);
        const said = await qa('lineup say four and two, make the button bigger', /QA lineup say (.+)\n/);
        check('the pill says what was sent', said?.ok === true && said.message === 'Sent 2 picks', said);
        const r = await Promise.race([call, sleep(5000).then(() => null)]);
        check('"four and two, make the button bigger" returns d then b, with the comment and raw', r?.result?.answered === true && JSON.stringify(r.result.picks) === '["d","b"]' && r.result.ranked === true && r.result.comment === 'make the button bigger' && typeof r.result.raw === 'string', r);
      },
    },
    {
      id: 'J12.5',
      name: 'Esc closes the sheet back to the card; ✕ on the card ends the call as dismissed',
      async run({ OUT, session, sleep, cmd, cards, sheet, check }) {
        const { work } = folders(OUT);
        const agent = session({ client: 'claude-code', title: 'Claude Code', cwd: work });
        const call = agent.call('lineup', { title: 'Pick a hero', candidates: heroes(work).slice(0, 2), timeout_s: 60 });
        await until(cards, (v) => v?.top?.kind === 'lineup', sleep);
        cmd('lineup open');
        await until(sheet, (v) => v?.kind === 'lineup' && v.visible, sleep);
        cmd('lineup key Escape');
        await sleep(500);
        const s = await sheet();
        const c = await cards();
        check('Esc closes the sheet and the card stays', s && !s.open && c?.top?.kind === 'lineup', { s, c });
        cmd('card dismiss');
        const r = await Promise.race([call, sleep(5000).then(() => null)]);
        check('✕ returns answered false, dismissed, with the card id', r?.result?.answered === false && r.result.reason === 'dismissed' && typeof r.result.card_id === 'string', r);
      },
    },
  ],
};
