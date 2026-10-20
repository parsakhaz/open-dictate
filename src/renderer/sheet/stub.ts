// P0's empty page: the sheet's material, size and Esc, opened from QA (`sheet stub`) to check the window itself.
import { h } from '../bridge';
import type { SheetPage } from './types';

export const stub: SheetPage = {
  show(root, payload) {
    const p = (payload ?? {}) as { title?: unknown; note?: unknown };
    const title = typeof p.title === 'string' ? p.title : 'Sheet window';
    const note = typeof p.note === 'string' ? p.note : 'The big surfaces open here, right above the pill.';
    root.replaceChildren(
      h('div.shead', {}, h('span.ttl', {}, title), h('span', {}, `· ${document.body.dataset.kind ?? ''}`)),
      h('div.sbody', {}, h('div.msg', {}, note)),
      h('div.sfoot', {}, h('kbd', {}, 'Esc'), 'closes'),
    );
  },
};
