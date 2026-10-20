// The Settings window's building blocks, shared by its pages and the surfaces' sections of Settings → Agents.
import { bindingLabel } from '../core/hotkeys';
import type { Binding } from '../core/types';
import { dictate, h } from './bridge';

export function card(title: string, desc: string | Node | null, control?: Node | null, extra?: Node | null): HTMLElement {
  return h('section.card', {}, h('div.cardrow', {}, h('div.cardtext', {}, h('div.cardtitle', {}, title), desc ? h('div.carddesc', {}, desc) : null), control ? h('div.control', {}, control) : null), extra ?? null);
}

export function toggle(on: boolean, onChange: (v: boolean) => void, label?: string): HTMLElement {
  const text = h('span.toggletext', {}, on ? 'On' : 'Off');
  const input = h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked;
    text.textContent = checked ? 'On' : 'Off';
    onChange(checked);
  } });
  return h('label.toggle', {}, text, input, h('span.track', {}, h('span.thumb')), label ? h('span.sr', {}, label) : null);
}

export function select<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
  const s = h('select.select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  return s;
}

export function radios<T extends string>(name: string, value: T, options: [T, string, string][], onChange: (v: T) => void): HTMLElement {
  return h(
    'div.radios',
    {},
    ...options.map(([v, l, d]) =>
      h('label.radio', {}, h('input', { type: 'radio', name, checked: v === value, onchange: () => onChange(v) }), h('span.radiodot'), h('span.radiotext', {}, h('span', {}, l), d ? h('span.radiodesc', {}, d) : null)),
    ),
  );
}

export function keycap(label: string): HTMLElement {
  return h('span.keys', {}, ...label.split(' + ').map((k) => h('kbd', {}, k)));
}

/**
 * A key shown as keycaps, with Change (records the next keys pressed) and, when `onClear` is given, Turn off. For
 * the surfaces' keys (the agent key, the point key, the snooze and round shortcuts).
 */
export function keyRecorder(b: Binding | null, onChange: (b: Binding) => void, onClear?: () => void): HTMLElement {
  const label = bindingLabel(b);
  const shown = () => (label === 'Off' ? h('span.muted', {}, 'Off') : keycap(label));
  const box = h('div.binding', {}, shown());
  const change = h(
    'button.button',
    {
      onclick: async () => {
        box.replaceChildren(h('span.recording', {}, 'Press the keys, then release…'));
        change.disabled = true;
        const next = await dictate.invoke<Binding | null>('dictate:record-binding');
        change.disabled = false;
        // Esc while recording keeps the key as it was.
        if (next) onChange(next);
        else box.replaceChildren(shown());
      },
    },
    'Change',
  );
  const clear = onClear && label !== 'Off' ? h('button.button.subtle', { onclick: onClear }, 'Turn off') : null;
  return h('div.bindingrow', {}, box, change, clear);
}
