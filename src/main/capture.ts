// Which capture path a recording uses: native WASAPI (fast to start) when it is available, the browser path in
// the pill (getUserMedia) otherwise, and the browser path again for a recording whose mic native could not open.
export interface CapturePath {
  start(id: number, deviceId: string | null, gainDb: number): void;
  stop(id: number): void;
  cancel(id: number): void;
  switchDevice(id: number, deviceId: string | null, gainDb: number): void;
}

export class CaptureRouter {
  private readonly path = new Map<number, 'native' | 'browser'>();
  private readonly request = new Map<number, { deviceId: string | null; gainDb: number }>();

  constructor(
    private readonly native: () => CapturePath | null,
    private readonly browser: CapturePath,
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void,
  ) {}

  pathOf(id: number): 'native' | 'browser' | undefined {
    return this.path.get(id);
  }

  start(id: number, deviceId: string | null, gainDb: number): void {
    this.request.set(id, { deviceId, gainDb });
    const n = this.native();
    this.path.set(id, n ? 'native' : 'browser');
    (n ?? this.browser).start(id, deviceId, gainDb);
  }

  /** Native capture could not open recording `id`'s mic: the browser path takes it over. False if it was not native. */
  nativeFailed(id: number, message: string): boolean {
    const req = this.request.get(id);
    if (this.path.get(id) !== 'native' || !req) return false;
    this.log('warn', `capture ${id}: native capture failed (${message}); using the browser path`);
    this.path.set(id, 'browser');
    this.browser.start(id, req.deviceId, req.gainDb);
    return true;
  }

  private of(id: number): CapturePath {
    return (this.path.get(id) === 'native' && this.native()) || this.browser;
  }

  stop(id: number): void {
    this.of(id).stop(id);
    this.forget(id);
  }

  cancel(id: number): void {
    this.of(id).cancel(id);
    this.forget(id);
  }

  switchDevice(id: number, deviceId: string | null, gainDb: number): void {
    if (this.request.has(id)) this.request.set(id, { deviceId, gainDb });
    this.of(id).switchDevice(id, deviceId, gainDb);
  }

  private forget(id: number): void {
    this.path.delete(id);
    this.request.delete(id);
  }
}
