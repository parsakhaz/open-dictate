// The surface features, in the order their lanes merge. This list is shared and complete: each lane fills in its
// own file and never adds a line here.
import { decide } from './decide';
import type { Feature } from './host';
import { inbox } from './inbox';
import { lineup } from './lineup';
import { peek } from './peek';
import { point } from './point';
import { voice } from './voice';

export const FEATURES: Feature[] = [decide, inbox, voice, lineup, peek, point];
