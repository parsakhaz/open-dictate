interface ProtectedWindow {
  isDestroyed(): boolean;
  isContentProtected(): boolean;
  setContentProtection(on: boolean): void;
}

// A window remains excluded until every overlapping own capture has finished.
const leases = new WeakMap<ProtectedWindow, { count: number; original: boolean }>();
export function protectCapture(windows: ProtectedWindow[]): () => void {
  const own = [...new Set(windows)].filter((w) => !w.isDestroyed());
  for (const w of own) {
    const lease = leases.get(w) ?? { count: 0, original: w.isContentProtected() };
    if (!lease.count) w.setContentProtection(true);
    lease.count++;
    leases.set(w, lease);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const w of own) {
      const lease = leases.get(w)!;
      if (--lease.count) continue;
      leases.delete(w);
      if (!w.isDestroyed()) w.setContentProtection(lease.original);
    }
  };
}
