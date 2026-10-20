// Every tool the bridge may list: the six built in, then one module per surface, each hidden until its lane turns
// it on (`enabled` in its own file). This list is shared and complete: a lane never adds a line here. Pure.
import { TOOLS, type ToolDef } from '../agenttools';
import { approve } from './approve';
import { cardStatus } from './card_status';
import { decide } from './decide';
import { lineup } from './lineup';
import { peek } from './peek';
import type { ToolModule } from './types';

export const SURFACE_TOOLS: ToolModule[] = [decide, approve, cardStatus, lineup, peek];

/** What tools/list returns: the built-in tools and the surfaces turned on. */
export function listedTools(modules: ToolModule[] = SURFACE_TOOLS): ToolDef[] {
  return [...TOOLS, ...modules.filter((m) => m.enabled).map((m) => m.def)];
}

export function isListed(name: string, modules: ToolModule[] = SURFACE_TOOLS): boolean {
  return listedTools(modules).some((t) => t.name === name);
}
