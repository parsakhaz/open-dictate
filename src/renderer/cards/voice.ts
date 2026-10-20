// "Voice has a draft · Open": the orchestrator's composer had text, so nothing was sent (L3).
// Until its lane draws it, the standard body.
import { standard } from './standard';
import type { CardBody } from './types';

export const voiceDraft: CardBody = standard;
