// "Send to the orchestrator": the one contract between talking to agents (L3, which provides it) and point and say
// (L6, which uses it). Until L3 provides it, nothing is sent and callers are told so.

export interface OrchestratorMessage {
  /** The words, already previewed or reviewed by the person. Dictate adds its "[Dictate · …]" prefix. */
  text: string;
  /** Who is speaking: the agent key, or point and say. */
  via: 'voice' | 'point';
  /** Long text goes as a file the agent reads (runpane agents send --as-file-pointer). */
  asFilePointer?: boolean;
}

export type OrchestratorResult =
  | { delivered: true; state: 'taken' | 'queued' }
  /** `draft`: the orchestrator's composer had text, so nothing was sent. */
  | { delivered: false; blocked: 'not-set-up' | 'not-running' | 'draft' | 'pane-missing' | 'error'; message?: string };

export interface Orchestrator {
  /** Pane is installed and a Voice Session is set (or can be created). */
  available(): boolean;
  send(m: OrchestratorMessage): Promise<OrchestratorResult>;
}

/** Before L3: there is nowhere to send. */
export const NO_ORCHESTRATOR: Orchestrator = {
  available: () => false,
  send: async () => ({ delivered: false, blocked: 'not-set-up', message: 'Talking to agents isn’t built yet.' }),
};
