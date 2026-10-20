// Which body draws each card kind. Shared and complete: every kind already has its module, so a lane fills in its
// own file and never adds a line here.
import type { CardKind } from '../../core/cards';
import { approve } from './approve';
import { decide } from './decide';
import { lineup } from './lineup';
import { peek } from './peek';
import { pointReview } from './point';
import { roundSummary } from './round';
import { standard } from './standard';
import type { CardBody } from './types';
import { voiceDraft } from './voice';

export const BODIES: Record<CardKind, CardBody> = {
  'pane-blocked': standard,
  'pane-ready': standard,
  notify: standard,
  ask: standard,
  consent: standard,
  vocab: standard,
  decide,
  approve,
  'round-summary': roundSummary,
  'voice-draft': voiceDraft,
  lineup,
  peek,
  'point-review': pointReview,
};
