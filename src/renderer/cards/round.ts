// The round summary: what the round did, one row per card with its question and the answer sent, with Done, Undo for
// the last action while it can be taken back, and Open inbox while cards still wait (L2). Its buttons go to the
// inbox's handler as { action: 'kind', name }.
import { plainTitle } from '../../core/cardtext';
import { h } from '../bridge';
import type { CardBody } from './types';

interface Row {
  action: 'approved' | 'answered' | 'snoozed' | 'skipped' | 'opened';
  title: string;
  tab: string;
  text?: string;
  back?: string;
}
interface SummaryData {
  results?: Row[];
  undo?: Row['action'] | null;
  waiting?: number;
}

const LABEL: Record<Row['action'], string> = { approved: 'Approved', answered: 'Answered', snoozed: 'Snoozed', skipped: 'Skipped', opened: 'Opened' };

export const roundSummary: CardBody = {
  parts(c, ctx) {
    const d = (c.data ?? {}) as SummaryData;
    const rows = (d.results ?? []).map((r) =>
      h(
        'div.rrow',
        { 'data-action': r.action },
        h('span.rtag', {}, LABEL[r.action] ?? r.action),
        h('span.rwhat', {}, r.action === 'snoozed' && r.back ? `${plainTitle(r.title)} · back at ${r.back}` : plainTitle(r.title), r.text ? h('span.rans', {}, r.text) : null),
        h('span.rtab', {}, r.tab),
      ),
    );
    const buttons = h(
      'div.crow',
      {},
      ctx.button('Done', { id: c.id, action: 'kind', name: 'done' }, '.primary'),
      d.undo ? ctx.button(`Undo ${d.undo === 'approved' ? 'approval' : d.undo === 'answered' ? 'answer' : 'snooze'}`, { id: c.id, action: 'kind', name: 'undo' }) : null,
      d.waiting ? ctx.button('Open inbox', { id: c.id, action: 'kind', name: 'round' }) : null,
    );
    return [h('div.title', {}, plainTitle(c.title)), h('div.rrows', {}, ...rows), buttons];
  },
};
