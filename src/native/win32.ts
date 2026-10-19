// The few Win32 calls dictate needs, through koffi: real key events (SendInput), the foreground window and
// its caret, and waking the hook thread. Main process only.
import koffi from 'koffi';
import { DICTATE_EXTRA } from './constants';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT });
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
const GUITHREADINFO = koffi.struct('GUITHREADINFO', {
  cbSize: 'uint32',
  flags: 'uint32',
  hwndActive: 'intptr',
  hwndFocus: 'intptr',
  hwndCapture: 'intptr',
  hwndMenuOwner: 'intptr',
  hwndMoveSize: 'intptr',
  hwndCaret: 'intptr',
  rcCaret: RECT,
});

const SendInput = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int32']);
const GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'intptr', []);
const SetForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'bool', ['intptr']);
const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr', koffi.out(koffi.pointer('uint32'))]);
const GetGUIThreadInfo = user32.func('__stdcall', 'GetGUIThreadInfo', 'bool', ['uint32', koffi.inout(koffi.pointer(GUITHREADINFO))]);
const ClientToScreen = user32.func('__stdcall', 'ClientToScreen', 'bool', ['intptr', koffi.inout(koffi.pointer(POINT))]);
const GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int', ['intptr', 'void *', 'int']);
const IsWindow = user32.func('__stdcall', 'IsWindow', 'bool', ['intptr']);
const PostThreadMessageW = user32.func('__stdcall', 'PostThreadMessageW', 'bool', ['uint32', 'uint32', 'uintptr', 'intptr']);
const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []);
const QueryFullProcessImageNameW = kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', ['intptr', 'uint32', 'void *', koffi.inout(koffi.pointer('uint32'))]);
const AllowSetForegroundWindow = user32.func('__stdcall', 'AllowSetForegroundWindow', 'bool', ['uint32']);

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x2;
const KEYEVENTF_EXTENDEDKEY = 0x1;
const EXTENDED = new Set([0xa3, 0xa5, 0x2d, 0x2e, 0x24, 0x23, 0x21, 0x22, 0x25, 0x26, 0x27, 0x28]);

export interface KeyStroke {
  vk: number;
  up?: boolean;
}

/** Sends the strokes as one atomic SendInput batch. Returns how many were inserted (0 = blocked). */
export function sendKeys(strokes: KeyStroke[]): number {
  const inputs = strokes.map((s) => ({
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: s.vk, wScan: 0, dwFlags: (s.up ? KEYEVENTF_KEYUP : 0) | (EXTENDED.has(s.vk) ? KEYEVENTF_EXTENDEDKEY : 0), time: 0, dwExtraInfo: DICTATE_EXTRA } },
  }));
  return SendInput(inputs.length, inputs, koffi.sizeof(INPUT));
}

const KEYEVENTF_UNICODE = 0x4;

/** Types `text` as Unicode key events, for when the clipboard cannot be used. Returns false if any batch was blocked. */
export function typeText(text: string): boolean {
  const inputs: unknown[] = [];
  const key = (ki: Record<string, number>) => inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: DICTATE_EXTRA, ...ki } } });
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    if (ch === '\n') {
      key({ wVk: 0x0d });
      key({ wVk: 0x0d, dwFlags: KEYEVENTF_KEYUP });
      continue;
    }
    for (let i = 0; i < ch.length; i++) {
      const code = ch.charCodeAt(i);
      key({ wScan: code, dwFlags: KEYEVENTF_UNICODE });
      key({ wScan: code, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP });
    }
  }
  // Small batches, so a slow app's input queue is not flooded.
  for (let i = 0; i < inputs.length; i += 64) {
    const batch = inputs.slice(i, i + 64);
    if (SendInput(batch.length, batch, koffi.sizeof(INPUT)) !== batch.length) return false;
  }
  return true;
}

export const VK_CONTROL = 0x11;
export const VK_V = 0x56;

export function sendCtrlV(): number {
  return sendKeys([{ vk: VK_CONTROL }, { vk: VK_V }, { vk: VK_V, up: true }, { vk: VK_CONTROL, up: true }]);
}

export function sendEnter(): boolean {
  return sendKeys([{ vk: 0x0d }, { vk: 0x0d, up: true }]) === 2;
}

export function foregroundWindow(): number {
  return Number(GetForegroundWindow());
}

export function isWindow(hwnd: number): boolean {
  return !!hwnd && IsWindow(hwnd);
}

export function setForeground(hwnd: number): boolean {
  return SetForegroundWindow(hwnd);
}

export function windowClass(hwnd: number): string {
  const buf = Buffer.alloc(512);
  const n = GetClassNameW(hwnd, buf, 256);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

export function windowPid(hwnd: number): number {
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** The executable a process runs, or '' when Windows won't say. */
export function processImage(pid: number): string {
  if (!pid) return '';
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h) return '';
  try {
    const buf = Buffer.alloc(2048);
    const len = [1024];
    return QueryFullProcessImageNameW(h, 0, buf, len) ? buf.toString('utf16le', 0, len[0] * 2) : '';
  } finally {
    CloseHandle(h);
  }
}

/**
 * Lets any process take the foreground once. Called right after the person clicks a card, while Dictate holds the
 * last input, so Pane can come to the front instead of only flashing its taskbar button.
 */
export function allowAnyForeground(): boolean {
  return AllowSetForegroundWindow(0xffffffff);
}

/** Windows with no text field to paste into: the desktop and the taskbar. */
const NO_TEXT_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

export function looksLikeNoTextTarget(hwnd: number): boolean {
  return !hwnd || NO_TEXT_CLASSES.has(windowClass(hwnd));
}

/** The foreground window's caret in physical screen pixels, when the app exposes one (Win32 edit controls, Chromium). */
export function caretRect(): { x: number; y: number; width: number; height: number } | null {
  const fg = foregroundWindow();
  if (!fg) return null;
  const tid = GetWindowThreadProcessId(fg, [0]);
  const info = { cbSize: koffi.sizeof(GUITHREADINFO), flags: 0, hwndActive: 0, hwndFocus: 0, hwndCapture: 0, hwndMenuOwner: 0, hwndMoveSize: 0, hwndCaret: 0, rcCaret: { left: 0, top: 0, right: 0, bottom: 0 } };
  if (!GetGUIThreadInfo(tid, info) || !info.hwndCaret) return null;
  const r = info.rcCaret;
  if (r.right === 0 && r.bottom === 0 && r.left === 0 && r.top === 0) return null;
  const p = { x: r.left, y: r.top };
  if (!ClientToScreen(info.hwndCaret, p)) return null;
  return { x: p.x, y: p.y, width: Math.max(1, r.right - r.left), height: Math.max(1, r.bottom - r.top) };
}

const SYSTEM_POWER_STATUS = koffi.struct('SYSTEM_POWER_STATUS', { ACLineStatus: 'uint8', BatteryFlag: 'uint8', BatteryLifePercent: 'uint8', SystemStatusFlag: 'uint8', BatteryLifeTime: 'uint32', BatteryFullLifeTime: 'uint32' });
const GetSystemPowerStatus = kernel32.func('__stdcall', 'GetSystemPowerStatus', 'bool', [koffi.out(koffi.pointer(SYSTEM_POWER_STATUS))]);

/** Windows' battery saver is on. */
export function batterySaverOn(): boolean {
  const st = { ACLineStatus: 0, BatteryFlag: 0, BatteryLifePercent: 0, SystemStatusFlag: 0, BatteryLifeTime: 0, BatteryFullLifeTime: 0 };
  return GetSystemPowerStatus(st) && (st.SystemStatusFlag & 1) === 1;
}

export function postThreadMessage(tid: number, msg: number): boolean {
  return PostThreadMessageW(tid, msg, 0, 0);
}

export function lastError(): number {
  return GetLastError();
}

// ---------- child processes die with dictate ----------

const JOBOBJECT_EXTENDED_LIMIT_INFORMATION = koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
  PerProcessUserTimeLimit: 'int64',
  PerJobUserTimeLimit: 'int64',
  LimitFlags: 'uint32',
  MinimumWorkingSetSize: 'uintptr',
  MaximumWorkingSetSize: 'uintptr',
  ActiveProcessLimit: 'uint32',
  Affinity: 'uintptr',
  PriorityClass: 'uint32',
  SchedulingClass: 'uint32',
  ReadOperationCount: 'uint64',
  WriteOperationCount: 'uint64',
  OtherOperationCount: 'uint64',
  ReadTransferCount: 'uint64',
  WriteTransferCount: 'uint64',
  OtherTransferCount: 'uint64',
  ProcessMemoryLimit: 'uintptr',
  JobMemoryLimit: 'uintptr',
  PeakProcessMemoryUsed: 'uintptr',
  PeakJobMemoryUsed: 'uintptr',
});
const CreateJobObjectW = kernel32.func('__stdcall', 'CreateJobObjectW', 'intptr', ['intptr', 'intptr']);
const SetInformationJobObject = kernel32.func('__stdcall', 'SetInformationJobObject', 'bool', ['intptr', 'int', koffi.pointer(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), 'uint32']);
const AssignProcessToJobObject = kernel32.func('__stdcall', 'AssignProcessToJobObject', 'bool', ['intptr', 'intptr']);
const OpenProcess = kernel32.func('__stdcall', 'OpenProcess', 'intptr', ['uint32', 'bool', 'uint32']);
const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['intptr']);

let job = 0;

/**
 * Puts `pid` in a job that Windows kills when dictate's last handle to it closes, which happens however
 * dictate exits (quit, crash, Task Manager). Without it, a killed dictate leaves llama-servers holding GPU memory.
 */
export function killWithUs(pid: number): boolean {
  if (!job) {
    job = Number(CreateJobObjectW(0, 0));
    if (!job) return false;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const info = {
      PerProcessUserTimeLimit: 0,
      PerJobUserTimeLimit: 0,
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0,
      ProcessMemoryLimit: 0,
      JobMemoryLimit: 0,
      PeakProcessMemoryUsed: 0,
      PeakJobMemoryUsed: 0,
    };
    // JobObjectExtendedLimitInformation = 9
    if (!SetInformationJobObject(job, 9, info, koffi.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))) return false;
  }
  const PROCESS_SET_QUOTA = 0x0100;
  const PROCESS_TERMINATE = 0x0001;
  const h = Number(OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid));
  if (!h) return false;
  const ok = AssignProcessToJobObject(job, h);
  CloseHandle(h);
  return ok;
}

// ---------- clipboard text that stays on this PC ----------

const OpenClipboard = user32.func('__stdcall', 'OpenClipboard', 'bool', ['intptr']);
const CloseClipboard = user32.func('__stdcall', 'CloseClipboard', 'bool', []);
const EmptyClipboard = user32.func('__stdcall', 'EmptyClipboard', 'bool', []);
const SetClipboardData = user32.func('__stdcall', 'SetClipboardData', 'intptr', ['uint32', 'intptr']);
const RegisterClipboardFormatW = user32.func('__stdcall', 'RegisterClipboardFormatW', 'uint32', ['str16']);
const CreateWindowExW = user32.func('__stdcall', 'CreateWindowExW', 'intptr', ['uint32', 'str16', 'str16', 'uint32', 'int', 'int', 'int', 'int', 'intptr', 'intptr', 'intptr', 'intptr']);
const GlobalAlloc = kernel32.func('__stdcall', 'GlobalAlloc', 'intptr', ['uint32', 'uintptr']);
const GlobalLock = kernel32.func('__stdcall', 'GlobalLock', 'intptr', ['intptr']);
const GlobalUnlock = kernel32.func('__stdcall', 'GlobalUnlock', 'bool', ['intptr']);
const GlobalFree = kernel32.func('__stdcall', 'GlobalFree', 'intptr', ['intptr']);
const RtlMoveMemory = kernel32.func('__stdcall', 'RtlMoveMemory', 'void', ['intptr', 'void *', 'uintptr']);

const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x2;
const HWND_MESSAGE = -3;

let clipOwner = 0;
const formats = new Map<string, number>();
function format(name: string): number {
  const id = formats.get(name) ?? (RegisterClipboardFormatW(name) as number);
  formats.set(name, id);
  return id;
}

/** Hands `data` to the clipboard as a new global block; the clipboard owns it once this succeeds. */
function setData(fmt: number, data: Buffer): void {
  const h = Number(GlobalAlloc(GMEM_MOVEABLE, data.length));
  if (!h) throw new Error(`GlobalAlloc failed (${GetLastError()})`);
  const p = Number(GlobalLock(h));
  if (!p) {
    GlobalFree(h);
    throw new Error(`GlobalLock failed (${GetLastError()})`);
  }
  RtlMoveMemory(p, data, data.length);
  GlobalUnlock(h);
  if (!Number(SetClipboardData(fmt, h))) {
    const err = GetLastError();
    GlobalFree(h);
    throw new Error(`SetClipboardData failed (${err})`);
  }
}

/**
 * Puts `text` on the clipboard with Windows' privacy formats: never uploaded to the cloud clipboard and, unless
 * `history` is true, kept out of Win+V history and clipboard monitors. Electron's clipboard cannot set these, so
 * it is written here. Retries for about 200 ms while another app has the clipboard open.
 */
export async function writeClipboardText(text: string, opts: { history: boolean }): Promise<void> {
  // A message-only window owns the clipboard: with no owner, SetClipboardData fails after EmptyClipboard.
  if (!clipOwner) clipOwner = Number(CreateWindowExW(0, 'STATIC', 'dictate-clipboard', 0, 0, 0, 0, 0, HWND_MESSAGE, 0, 0, 0));
  if (!clipOwner) throw new Error(`cannot create the clipboard window (${GetLastError()})`);
  for (let i = 0; !OpenClipboard(clipOwner); i++) {
    if (i >= 10) throw new Error('clipboard busy');
    await new Promise((r) => setTimeout(r, 20));
  }
  try {
    if (!EmptyClipboard()) throw new Error(`EmptyClipboard failed (${GetLastError()})`);
    setData(CF_UNICODETEXT, Buffer.from(`${text}\0`, 'utf16le'));
    const no = Buffer.alloc(4); // a DWORD 0: "no"
    setData(format('CanUploadToCloudClipboard'), no);
    if (!opts.history) {
      setData(format('CanIncludeInClipboardHistory'), no);
      setData(format('ExcludeClipboardContentFromMonitorProcessing'), no);
    }
  } finally {
    CloseClipboard();
  }
}
