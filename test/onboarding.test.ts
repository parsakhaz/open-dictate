import { describe, expect, it } from 'vitest';
import { canGoBack, canSkip, nextStep, previousStep, resumeStep, STEPS, type Step, stepNumber, tryReady, tryWait, upgradedOnboarded, keepsLlamaServer, appliesMeasuredChain } from '../src/core/onboarding';

const seen = { licencesSeen: true, speechReady: false };
const fresh = { licencesSeen: false, speechReady: false };

describe('first-run walkthrough', () => {
  it('walks welcome → licences → download → hardware → microphone → hotkey → try → done', () => {
    const walked = ['welcome'];
    let step: Step = STEPS[0];
    while (step !== 'done') {
      step = nextStep(step);
      walked.push(step);
    }
    expect(walked).toEqual(['welcome', 'licences', 'download', 'hardware', 'microphone', 'hotkey', 'try', 'done']);
  });

  it('resumes at the step where it was closed', () => {
    for (const step of STEPS) expect(resumeStep(step, seen)).toBe(step);
  });

  it('starts over on a missing or unknown saved step', () => {
    expect(resumeStep(undefined, fresh)).toBe('welcome');
    expect(resumeStep('elsewhere', seen)).toBe('welcome');
  });

  it('never resumes past the licences before they were shown', () => {
    for (const step of ['download', 'hardware', 'microphone', 'hotkey', 'try', 'done']) expect(resumeStep(step, fresh)).toBe('licences');
    expect(resumeStep('welcome', fresh)).toBe('welcome');
  });

  it('can skip every step except the licences and the last', () => {
    expect(STEPS.filter((s) => !canSkip(s))).toEqual(['licences', 'done']);
  });

  it('goes back from every step but the first', () => {
    expect(STEPS.filter((s) => !canGoBack(s))).toEqual(['welcome']);
    expect(previousStep('download')).toBe('licences');
    expect(previousStep('welcome')).toBe('welcome');
  });

  it('keeps "Try it" waiting until the recognizer has loaded, not only until the files are on disk', () => {
    expect(tryWait(false, 'error')).toBe('download');
    expect(tryWait(true, 'loading')).toBe('loading');
    expect(tryWait(true, 'error')).toBe('error');
    expect(tryWait(true, 'ready')).toBe(null);
  });

  it('keeps "Try it" waiting until the speech model is installed, whatever happened to the download', () => {
    expect(tryReady({ licencesSeen: true, speechReady: false })).toBe(false);
    expect(tryReady({ licencesSeen: true, speechReady: true })).toBe(true);
    // A failed download still lets the later steps run.
    expect(nextStep('download')).toBe('hardware');
  });

  it('numbers the steps for people, 1 of 8 to 8 of 8', () => {
    expect(stepNumber('welcome')).toEqual({ index: 1, total: 8 });
    expect(stepNumber('done')).toEqual({ index: 8, total: 8 });
  });

  it('marks a working profile from before Getting started as onboarded, and leaves new or unfinished ones alone', () => {
    // Saved before the walkthrough existed (no onboardingStep), with the speech model present: it already works.
    expect(upgradedOnboarded({ version: 1, cleanup: 'gemma-emberon' }, true)).toBe(true);
    expect(upgradedOnboarded({ version: 1, cleanup: 'gemma-emberon' }, false)).toBe(false);
    // No saved file: a fresh install sees the walkthrough.
    expect(upgradedOnboarded(undefined, true)).toBe(false);
    // Saved by this version: whatever it says.
    expect(upgradedOnboarded({ onboarded: false, onboardingStep: 'download' }, true)).toBe(false);
    expect(upgradedOnboarded({ onboarded: true, onboardingStep: 'done' }, false)).toBe(true);
  });

  it('points at the downloaded llama-server only when the person has no working one set', () => {
    const exists = (p: string) => p === 'C:/voice-lab/llama-server.exe';
    expect(keepsLlamaServer('C:/voice-lab/llama-server.exe', exists)).toBe(true);
    expect(keepsLlamaServer('llama-server', exists)).toBe(false);
    expect(keepsLlamaServer('C:/gone/llama-server.exe', exists)).toBe(false);
  });

  it('lets the speed check change the cleanup chain during Getting started or when asked, never on its own afterwards', () => {
    expect(appliesMeasuredChain({ onboarded: false, requested: false })).toBe(true);
    expect(appliesMeasuredChain({ onboarded: true, requested: true })).toBe(true);
    expect(appliesMeasuredChain({ onboarded: true, requested: false })).toBe(false);
  });
});
