import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silenceGeneratedInput } from '../src/native/generated-input';
import type { FromHook } from '../src/native/keyhook-worker';
import { PortableKeyHook } from '../src/native/portable-keyhook';

class NativeSource extends EventEmitter {
  starts = 0;
  stops = 0;
  start() { this.starts++; }
  stop() { this.stops++; }
}

afterEach(() => vi.restoreAllMocks());

describe('portable keyboard hook', () => {
  it('does not feed its own injected paste back into the dictation hotkeys', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const source = new NativeSource();
    const events: FromHook[] = [];
    const hook = new PortableKeyHook(source, (event) => events.push(event));
    hook.start();
    silenceGeneratedInput();
    source.emit('keydown', { keycode: 3675 });
    source.emit('keyup', { keycode: 3675 });
    expect(events).toEqual([{ type: 'ready', tid: 0 }]);
    now.mockReturnValue(1200);
    source.emit('keydown', { keycode: 3613, shiftKey: true });
    expect(events.at(-1)).toEqual({ type: 'key', vk: 0xa3, down: true, t: 1200, swallowed: false, shift: true });
    hook.stop();
    source.emit('keydown', { keycode: 3613 });
    expect(events).toHaveLength(2);
    expect(source.starts).toBe(1);
    expect(source.stops).toBe(1);
  });
});
