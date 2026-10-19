// Native Cocoa/Quartz integration, loaded only on macOS. Cocoa identities are application PIDs: restoring
// a target activates that application's last window. Accessibility supplies text-focus confirmation.
import koffi from 'koffi';
import type { DesktopAdapter } from './desktop';

export function createMacDesktop(): DesktopAdapter & { batterySaverOn(): boolean } {
  // Load AppKit before looking up its Objective-C classes.
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const ax = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const cls = objc.func('objc_getClass', 'void *', ['str']);
  const selector = objc.func('sel_registerName', 'void *', ['str']);
  const message = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const messagePid = objc.func('objc_msgSend', 'int', ['void *', 'void *']);
  const messageWithPid = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'int']);
  const activate = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'uint64']);
  const messageBool = objc.func('objc_msgSend', 'bool', ['void *', 'void *']);
  const release = cf.func('CFRelease', 'void', ['void *']);
  const string = cf.func('CFStringCreateWithCString', 'void *', ['void *', 'str', 'uint32']);
  const stringToBuffer = cf.func('CFStringGetCString', 'bool', ['void *', 'void *', 'long', 'uint32']);
  const createAX = ax.func('AXUIElementCreateApplication', 'void *', ['int']);
  const attribute = ax.func('AXUIElementCopyAttributeValue', 'int', ['void *', 'void *', koffi.out(koffi.pointer('void *'))]);
  const createKey = cg.func('CGEventCreateKeyboardEvent', 'void *', ['void *', 'uint16', 'bool']);
  const setFlags = cg.func('CGEventSetFlags', 'void', ['void *', 'uint64']);
  const setUnicode = cg.func('CGEventKeyboardSetUnicodeString', 'void', ['void *', 'ulong', 'void *']);
  const post = cg.func('CGEventPost', 'void', ['uint32', 'void *']);
  const UTF8 = 0x08000100;
  const commandFlag = 1 << 20;

  const foregroundWindow = () => {
    const workspace = message(cls('NSWorkspace'), selector('sharedWorkspace'));
    const app = message(workspace, selector('frontmostApplication'));
    return app ? messagePid(app, selector('processIdentifier')) : 0;
  };
  const live = (pid: number) => {
    if (pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  function event(key: number, down: boolean, flags = 0, text?: string): boolean {
    const e = createKey(null, key, down);
    if (!e) return false;
    try {
      setFlags(e, flags);
      if (text !== undefined) setUnicode(e, text.length, Buffer.from(text, 'utf16le'));
      post(0, e); // kCGHIDEventTap
      return true;
    } finally { release(e); }
  }
  function focusedRole(pid: number): string {
    const app = createAX(pid);
    if (!app) return '';
    const focusedName = string(null, 'AXFocusedUIElement', UTF8);
    const roleName = string(null, 'AXRole', UTF8);
    const focused = [null];
    const role = [null];
    try {
      if (attribute(app, focusedName, focused) !== 0 || !focused[0]) return '';
      if (attribute(focused[0], roleName, role) !== 0 || !role[0]) return '';
      const buf = Buffer.alloc(256);
      return stringToBuffer(role[0], buf, buf.length, UTF8) ? buf.toString('utf8').replace(/\0.*$/s, '') : '';
    } finally {
      if (role[0]) release(role[0]);
      if (focused[0]) release(focused[0]);
      release(focusedName); release(roleName); release(app);
    }
  }
  return {
    foregroundWindow,
    isWindow: live,
    setForeground: (pid) => {
      if (!live(pid)) return false;
      const app = messageWithPid(cls('NSRunningApplication'), selector('runningApplicationWithProcessIdentifier:'), pid);
      return !!app && activate(app, selector('activateWithOptions:'), 3);
    },
    windowPid: (pid) => pid,
    windowClass: () => '',
    looksLikeNoTextTarget: (pid) => !live(pid),
    caretRect: () => null,
    hasTextCaret: (pid) => foregroundWindow() === pid && ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'].includes(focusedRole(pid)),
    sendCtrlV: () => {
      // Modifier events carry the flag through V up, followed by a clean Command up.
      const accepted = [event(55, true, commandFlag), event(9, true, commandFlag), event(9, false, commandFlag), event(55, false)];
      return accepted.filter(Boolean).length;
    },
    sendEnter: () => event(36, true) && event(36, false),
    typeText: (text) => {
      for (const char of text.replace(/\r\n?/g, '\n')) {
        if (char === '\n') { if (!event(36, true) || !event(36, false)) return false; }
        else if (!event(0, true, 0, char) || !event(0, false, 0, char)) return false;
      }
      return true;
    },
    batterySaverOn: () => messageBool(message(cls('NSProcessInfo'), selector('processInfo')), selector('isLowPowerModeEnabled')),
  };
}
