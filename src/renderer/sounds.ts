// Subtle cues, synthesised: two soft rising notes on start, falling on stop, one low note on cancel.
let out: AudioContext | null = null;
let sleepTimer: ReturnType<typeof setTimeout> | undefined;

function tone(ctx: AudioContext, freq: number, at: number, dur: number, gain: number): void {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
}

export type Cue = 'start' | 'stop' | 'cancel' | 'error';

export function play(cue: Cue): void {
  out ??= new AudioContext({ latencyHint: 'interactive' });
  const ctx = out;
  void ctx.resume();
  const t = ctx.currentTime + 0.005;
  if (cue === 'start') {
    tone(ctx, 784, t, 0.09, 0.05);
    tone(ctx, 1175, t + 0.06, 0.12, 0.045);
  } else if (cue === 'stop') {
    tone(ctx, 1175, t, 0.08, 0.04);
    tone(ctx, 784, t + 0.055, 0.12, 0.04);
  } else if (cue === 'cancel') {
    tone(ctx, 440, t, 0.14, 0.045);
  } else {
    tone(ctx, 330, t, 0.1, 0.05);
    tone(ctx, 262, t + 0.09, 0.16, 0.05);
  }
  // Let the output device sleep again once the cue has played.
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => void ctx.suspend(), 600);
}
