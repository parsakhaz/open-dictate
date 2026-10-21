// The preload's bridge, typed for the renderers.
export interface Bridge {
  send(channel: string, ...args: unknown[]): void;
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, cb: (...args: never[]) => void): () => void;
}

export const dictate = (window as unknown as { dictate: Bridge }).dictate;

// Errors in any dictate page go to dictate.log: a page that silently stops working is otherwise invisible.
const page = location.pathname.split('/').pop() ?? '';
window.addEventListener('error', (e) => dictate.send('dictate:renderer-error', page, `${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => dictate.send('dictate:renderer-error', page, `unhandled rejection: ${(e.reason as Error)?.stack ?? String(e.reason)}`));

/** Tiny element helper: h('div.card', { onclick }, child, 'text'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}`,
  props: Partial<Record<string, unknown>> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag as K);
  if (tag === 'button') el.setAttribute('type', 'button');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
