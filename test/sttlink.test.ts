import { describe, expect, it } from 'vitest';
import { SttLink } from '../src/main/sttlink';

describe('SttLink', () => {
  it('connects only once both the recognizer and the pill page are up (port sent before the page loaded was lost)', () => {
    const links: string[] = [];
    const l = new SttLink<string>((w) => links.push(w));
    l.setWorker('w1');
    expect(links).toEqual([]);
    l.pillReady();
    expect(links).toEqual(['w1']);
  });

  it('works in the other order too', () => {
    const links: string[] = [];
    const l = new SttLink<string>((w) => links.push(w));
    l.pillReady();
    l.setWorker('w1');
    expect(links).toEqual(['w1']);
  });

  it('reconnects a restarted recognizer, and a reloaded or recreated pill', () => {
    const links: string[] = [];
    const l = new SttLink<string>((w) => links.push(w));
    l.pillReady();
    l.setWorker('w1');
    l.setWorker(undefined);
    l.setWorker('w2');
    l.pillReady(); // the page reloaded
    l.pillGone(); // the renderer crashed and a new pill is loading
    l.setWorker('w3');
    expect(links).toEqual(['w1', 'w2', 'w2']);
    l.pillReady();
    expect(links).toEqual(['w1', 'w2', 'w2', 'w3']);
  });
});
