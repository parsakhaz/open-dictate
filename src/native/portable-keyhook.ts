import type { FromHook, ToHook } from './keyhook-worker';
import { canonicalKeyCode } from './keymap';
import { generatedInputActive } from './generated-input';

type HookListener = (event: { keycode?: number; shiftKey?: boolean; x?: number; y?: number }) => void;
export interface PortableHookSource {
  on(name: string, listener: HookListener): unknown;
  removeListener(name: string, listener: HookListener): unknown;
  start(): void;
  stop(): void;
}

/** libuiohook observes keys; it cannot swallow them. The history picker therefore uses a focused window. */
export class PortableKeyHook {
  private started = false;
  private capture = false;
  private readonly listeners: [string, HookListener][] = [];

  constructor(private readonly source: PortableHookSource, private readonly emit: (event: FromHook) => void) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const [name, down] of [['keydown', true], ['keyup', false]] as const) {
      const listener = (event: { keycode?: number; shiftKey?: boolean }) => {
        if (generatedInputActive()) return;
        const vk = canonicalKeyCode(event.keycode ?? 0);
        if (vk !== null) this.emit({ type: 'key', vk, down, t: performance.now(), swallowed: false, shift: !!event.shiftKey });
      };
      this.source.on(name, listener);
      this.listeners.push([name, listener]);
    }
    const click = (event: { x?: number; y?: number }) => {
      if (this.capture) this.emit({ type: 'click', x: event.x ?? 0, y: event.y ?? 0 });
    };
    this.source.on('mousedown', click);
    this.listeners.push(['mousedown', click]);
    try {
      this.source.start();
      this.emit({ type: 'ready', tid: 0 });
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  send(message: ToHook): void {
    if (message.type === 'capture') this.capture = message.on;
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.capture = false;
    for (const [name, listener] of this.listeners.splice(0)) this.source.removeListener(name, listener);
    this.source.stop();
  }
}
