import { dictate, h } from './bridge';
import { mountCards } from './cards';

const root = document.getElementById('root')!;
const close = () => dictate.send('dictate:cards-close');
const header = h('header.window-head', {}, h('span', {}, 'Dictate'), h('button.window-close', { type: 'button', 'aria-label': 'Dismiss card or close inbox', onclick: close }, 'Close'));
const anchor = h('div.status', { hidden: true });
const undo = h('div.mic-undo', { hidden: true });
root.append(header, anchor, undo);
mountCards(root, anchor);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.repeat) { e.preventDefault(); close(); }
});
let timer: ReturnType<typeof setTimeout> | undefined;
dictate.on('dictate:pill', (m: { kind: string; undo?: boolean; message?: string; ms?: number }) => {
  clearTimeout(timer);
  undo.hidden = !(m.kind === 'toast' && m.undo);
  undo.replaceChildren();
  if (!undo.hidden) {
    undo.append(m.message ?? 'Microphone changed', h('button.cbtn', { onclick: () => { dictate.send('dictate:undo-mic'); undo.hidden = true; } }, 'Undo'));
    timer = setTimeout(() => { undo.hidden = true; }, m.ms ?? 4000);
  }
});
let scheduled = false;
let last = '';
function measure(): void {
  scheduled = false;
  const visible = !!root.querySelector('.cards.shown, .inbox.shown') || !undo.hidden;
  const height = Math.ceil(root.getBoundingClientRect().height);
  const encoded = JSON.stringify([height, visible]);
  if (encoded !== last) { last = encoded; dictate.send('dictate:cards-size', height, visible); }
}
function schedule(): void {
  if (!scheduled) { scheduled = true; requestAnimationFrame(measure); }
}
new ResizeObserver(schedule).observe(root);
new MutationObserver(schedule).observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
dictate.on('dictate:cards', () => { last = ''; schedule(); });
dictate.on('dictate:cards-reopen', () => { last = ''; schedule(); });
dictate.send('dictate:cards-ready');
schedule();
