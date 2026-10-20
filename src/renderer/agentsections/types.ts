// The contract of a Settings → Agents section: one per surface feature (index.ts lists them), drawn from the window's
// state (`st.settings.<section>` and `st.surfaces.<feature>`) with the shared building blocks in settingsui.ts.
import type { Settings } from '../../core/types';
import type { State } from '../settingsstate';

export interface SectionContext {
  st: State;
  /** Saves a settings change (a whole section object, e.g. { snooze: { ...st.settings.snooze, minutes } }) and redraws. */
  set(patch: Partial<Settings>): Promise<void>;
  /** Redraws with the state an IPC call returns (dictate.invoke('dictate:<feature>:<name>')). */
  refresh(next: Promise<State>): Promise<void>;
}

/** The section's heading and cards; nothing until its feature is built. */
export type Section = (ctx: SectionContext) => (Node | null)[];
