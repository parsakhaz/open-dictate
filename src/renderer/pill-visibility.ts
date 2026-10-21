import { dictate } from './bridge';

/** Hide the native host after its last original visual surface disappears. No input policy. */
export function watchPillVisibility(root: HTMLElement): void {
  let frame = 0;
  let visible: boolean | undefined;
  let hide: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const next = root.classList.contains('visible') || !!root.querySelector('.cards.shown > *, .inbox.shown');
      if (next === visible) return;
      visible = next;
      clearTimeout(hide);
      if (next) dictate.send('dictate:pill-content', true);
      else hide = setTimeout(() => dictate.send('dictate:pill-content', false), 220);
    });
  };
  new MutationObserver(schedule).observe(root, { subtree: true, attributes: true, childList: true });
  schedule();
}
