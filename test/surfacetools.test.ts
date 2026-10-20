// The surfaces' tool modules: each is listed only once its lane turns it on, and every tool that raises a card tells
// the agent how to write one (PR #13's rule).
import { describe, expect, it } from 'vitest';
import { CARD_RULE, TOOL_NAMES } from '../src/core/agenttools';
import { isListed, listedTools, SURFACE_TOOLS } from '../src/core/tools';
import type { ToolModule } from '../src/core/tools/types';

describe('surface tools', () => {
  it('has one module for each planned tool: decide, approve, card_status, lineup and peek', () => {
    expect(SURFACE_TOOLS.map((m) => m.def.name)).toEqual(['decide', 'approve', 'card_status', 'lineup', 'peek']);
  });

  it('lists a surface tool exactly when its module is enabled, after the six built in', () => {
    const listed = listedTools().map((t) => t.name);
    expect(listed.slice(0, 6)).toEqual([...TOOL_NAMES]);
    for (const m of SURFACE_TOOLS) expect(listed.includes(m.def.name)).toBe(m.enabled);
    const on: ToolModule[] = SURFACE_TOOLS.map((m) => ({ ...m, enabled: m.def.name === 'lineup' }));
    expect(listedTools(on).map((t) => t.name)).toEqual([...TOOL_NAMES, 'lineup']);
    expect(isListed('lineup', on)).toBe(true);
    expect(isListed('peek', on)).toBe(false);
  });

  it('gives every card-raising tool the card rule, and the read-only card_status none', () => {
    for (const m of SURFACE_TOOLS) {
      if (m.def.name === 'card_status') expect(m.def.annotations.readOnlyHint).toBe(true);
      else expect(m.def.description).toContain(CARD_RULE);
    }
  });

  it('gives each tool a closed object schema with its required fields', () => {
    const required: Record<string, string[]> = { decide: ['title', 'questions'], approve: ['title'], card_status: ['card_id'], lineup: ['title', 'candidates'], peek: ['title', 'target'] };
    for (const m of SURFACE_TOOLS) expect(m.def.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: required[m.def.name] });
  });
});
