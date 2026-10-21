import { pillPaintRect } from '../core/pillregion';
import { dictate } from './bridge';

/** Windows only: update on layout changes and finite transitions, then sleep. */
export function watchPillRegion(root: HTMLElement): () => void {
  let frame = 0;
  let last = '';
  const watched = new Set<HTMLElement>();
  const resize = new ResizeObserver(schedule);
  const mutations = new MutationObserver(schedule);
  mutations.observe(root, { subtree: true, attributes: true, childList: true, characterData: true });
  window.addEventListener('resize', schedule);
  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(report);
  }
  function report(): void {
    frame = 0;
    const surfaces = [
      ...root.querySelectorAll<HTMLElement>(
        '.cards.shown > *, .inbox.shown .shelf, .inbox.shown .toast, .inbox.shown .capsule',
      ),
    ];
    const status = root.querySelector<HTMLElement>('.status');
    const statusVisible = !!status && Number(getComputedStyle(status).opacity) > 0;
    if (statusVisible) surfaces.push(...status.querySelectorAll<HTMLElement>('.pill, .above.shown'));
    for (const el of watched)
      if (!surfaces.includes(el)) {
        resize.unobserve(el);
        watched.delete(el);
      }
    for (const el of surfaces)
      if (!watched.has(el)) {
        resize.observe(el);
        watched.add(el);
      }
    const rects = surfaces.map((el) => pillPaintRect(el.getBoundingClientRect(), getComputedStyle(el).boxShadow));
    const interactive =
      !!root.querySelector('.cards.shown > *, .inbox.shown button') ||
      (root.classList.contains('visible') && !!status?.querySelector('button:not([hidden])'));
    const encoded = JSON.stringify([rects, interactive]);
    if (encoded !== last) {
      last = encoded;
      dictate.send('dictate:pill-region', rects, interactive);
    }
    // Waveforms and other infinite animations do not change the window region.
    if (
      root
        .getAnimations({ subtree: true })
        .some((a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity)
    )
      schedule();
  }
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    window.removeEventListener('resize', schedule);
  };
}
