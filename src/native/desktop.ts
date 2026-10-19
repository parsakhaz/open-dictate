export interface CaretRect { x: number; y: number; width: number; height: number }

/** Target IDs are opaque and session-local: HWND on Windows, X11 Window ID, application PID on macOS. */
export interface DesktopAdapter {
  foregroundWindow(): number;
  isWindow(target: number): boolean;
  setForeground(target: number): boolean;
  windowClass(target: number): string;
  windowPid(target: number): number;
  looksLikeNoTextTarget(target: number): boolean;
  caretRect(): CaretRect | null;
  hasTextCaret(target: number): boolean;
  /** Cmd+V on macOS, Ctrl+V elsewhere (Ctrl+Shift+V in known X11 terminals). */
  sendCtrlV(): number;
  sendEnter(): boolean;
  typeText(text: string): boolean;
}

export const unavailableDesktop: DesktopAdapter = {
  foregroundWindow: () => 0, isWindow: () => false, setForeground: () => false,
  windowClass: () => '', windowPid: () => 0, looksLikeNoTextTarget: () => true,
  caretRect: () => null, hasTextCaret: () => false,
  sendCtrlV: () => 0, sendEnter: () => false, typeText: () => false,
};
