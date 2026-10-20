// Which page draws each sheet kind. Shared and complete: a lane fills in its own page and never adds a line here.
import type { SheetKind } from '../../core/sheetkinds';
import { decide } from './decide';
import { lineup } from './lineup';
import { peek } from './peek';
import { round } from './round';
import { stub } from './stub';
import type { SheetPage } from './types';

export const PAGES: Record<SheetKind, SheetPage> = { stub, decide, round, lineup, peek };
