// L3 · Talk to any agent: the agent key's route to the Pane "Voice" orchestrator (src/main/panelink.ts), and
// provideOrchestrator for point and say.
// Until that lane fills this in, it adds nothing: no tool, no key, no card.
import type { Feature } from './host';

export const voice: Feature = {
  name: 'voice',
  setup() {},
};
