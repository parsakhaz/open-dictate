// The sheet window's page: hosts one surface at a time (pages.ts), in the card material, right above the pill. Main
// says which page and with what data; Esc closes it unless the page uses Esc itself.
import { isSheetKind, type SheetKind, type SheetOpen } from '../../core/sheetkinds';
import { dictate, h } from '../bridge';
import { PAGES } from './pages';

const frame = h('div.sheet');
document.getElementById('root')!.append(frame);
let current: SheetKind | null = null;

function close(): void {
  if (current) PAGES[current].hide?.();
  current = null;
  delete document.body.dataset.kind;
  frame.replaceChildren();
}

dictate.on('dictate:sheet-open', (o: SheetOpen) => {
  if (!isSheetKind(o.kind)) return;
  if (current !== o.kind) {
    close();
    current = o.kind;
    document.body.dataset.kind = o.kind;
  }
  PAGES[o.kind].show(frame, o.payload);
});

dictate.on('dictate:sheet-close', close);

document.addEventListener('keydown', (e) => {
  if (!current) return;
  // Native controls own Enter/Space/arrows; Tab always traverses focus normally.
  // Escape still reaches the page (for a lightbox) or closes the sheet below.
  if (e.key !== 'Escape' && (e.key === 'Tab' || (e.target instanceof Element && e.target.closest('button, input, textarea, select, a[href], summary, [contenteditable]')))) return;
  if (PAGES[current].key?.(e)) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    dictate.send('dictate:sheet-esc');
  }
});

dictate.send('dictate:sheet-ready');
