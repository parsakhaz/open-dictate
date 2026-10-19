// The first-run walkthrough's steps: where it goes next, what can be skipped, and where it resumes after a quit.
// Pure; the settings window renders the steps and main saves the current one.

export const STEPS = ['welcome', 'licences', 'download', 'hardware', 'microphone', 'hotkey', 'try', 'done'] as const;
export type Step = (typeof STEPS)[number];

export interface StepContext {
  /** The models and licences step was shown (D9: informational, but never skipped). */
  licencesSeen: boolean;
  /** The speech model is installed, so a practice dictation can run. */
  speechReady: boolean;
}

const at = (step: Step) => STEPS.indexOf(step);
export const isStep = (x: unknown): x is Step => typeof x === 'string' && (STEPS as readonly string[]).includes(x);

export function nextStep(step: Step): Step {
  return STEPS[Math.min(at(step) + 1, STEPS.length - 1)];
}

export function previousStep(step: Step): Step {
  return STEPS[Math.max(at(step) - 1, 0)];
}

export const canSkip = (step: Step) => step !== 'licences' && step !== 'done';
export const canGoBack = (step: Step) => step !== 'welcome';

/** Downloads run in the background, so a failed or unfinished one only holds back the practice dictation. */
export const tryReady = (ctx: StepContext) => ctx.speechReady;

/** What "Try it" still waits for: the files, then the recognizer loading them (a few seconds after a download). */
export function tryWait(speechInstalled: boolean, stt: 'ready' | 'loading' | 'error'): 'download' | 'loading' | 'error' | null {
  if (!speechInstalled) return 'download';
  return stt === 'ready' ? null : stt;
}

export function resumeStep(saved: unknown, ctx: StepContext): Step {
  if (!isStep(saved)) return 'welcome';
  return !ctx.licencesSeen && at(saved) > at('licences') ? 'licences' : saved;
}

export const stepNumber = (step: Step) => ({ index: at(step) + 1, total: STEPS.length });

/**
 * Whether a loaded profile counts as onboarded. A settings file saved before Getting started existed has no
 * `onboardingStep`; if its speech model is installed it already works, so it skips the walkthrough.
 */
export function upgradedOnboarded(saved: unknown, speechInstalled: boolean): boolean {
  if (typeof saved !== 'object' || saved === null) return false;
  const s = saved as Record<string, unknown>;
  if (s.onboarded === true) return true;
  return !('onboardingStep' in s) && speechInstalled;
}

/** After a runtime download, keep a llama-server the person set that still exists; otherwise use the downloaded one. */
export const keepsLlamaServer = (current: string, exists: (p: string) => boolean) => current !== 'llama-server' && exists(current);

/** The speed check picks the chain during Getting started or when asked to; afterwards it only reports. */
export const appliesMeasuredChain = (p: { onboarded: boolean; requested: boolean }) => !p.onboarded || p.requested;
