// The pill's extras beyond the cards, one module per feature. Shared and complete: a lane fills in its own module and
// never adds a line here.
import { inbox } from './inbox';
import type { PillExtra } from './types';

export const EXTRAS: PillExtra[] = [inbox];
