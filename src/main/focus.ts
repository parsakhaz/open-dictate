// Cocoa activation is asynchronous. A successful activation request is not proof that paste will reach it.
interface FocusPort {
  current(): number;
  exists(target: number): boolean;
  activate(target: number): boolean;
  sleep?: (ms: number) => Promise<void>;
}

export async function focusForPaste(target: number, desktop: FocusPort): Promise<boolean> {
  if (!desktop.exists(target)) return false;
  if (desktop.current() === target) return true;
  if (!desktop.activate(target)) return false;
  const sleep = desktop.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < 20; i++) {
    if (!desktop.exists(target)) return false;
    if (desktop.current() === target) return true;
    await sleep(25);
  }
  return desktop.current() === target && desktop.exists(target);
}
