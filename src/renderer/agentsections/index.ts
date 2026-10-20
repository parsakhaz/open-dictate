// The surfaces' sections of Settings → Agents, in page order, after the alert settings. Shared and complete: a lane
// fills in its own section and never adds a line here.
import { peek } from './peek';
import { point } from './point';
import { snooze } from './snooze';
import type { Section } from './types';
import { voice } from './voice';

export type { SectionContext } from './types';

export const SECTIONS: Section[] = [voice, snooze, peek, point];
