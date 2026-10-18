// A low-level keyboard hook (WH_KEYBOARD_LL) on its own thread, so a busy main process never delays typing.
// Unlike uiohook it can swallow keys: the picker combo's last key (so Right Ctrl+V never pastes into the app)
// and, while the picker is open, the keys the picker uses, so the target app keeps focus. It also drops the fake
// Left Ctrl of AltGr layouts, and masks a lone Alt or Win press of a hotkey so no menu bar or Start opens.
import { type MessagePort, parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads';
import koffi from 'koffi';
import { AltGrFilter, bindingMatches, isModifier, VK } from '../core/hotkeys';
import type { Binding } from '../core/types';
import { DICTATE_EXTRA, WM_APP_MASK, WM_QUIT } from './constants';

export type ToHook =
  /** `mask`: keys that get the menu mask key injected while they are down (see menuMaskKeys). */
  | { type: 'config'; swallow: Binding[]; mask: number[] }
  /** Picker open: swallow every key except modifiers and Alt/Win combos, and report clicks. */
  | { type: 'capture'; on: boolean }
  /** While recording, Esc cancels the dictation and is not passed to the app. */
  | { type: 'recording'; on: boolean };

export type FromHook =
  | { type: 'ready'; tid: number }
  | { type: 'key'; vk: number; down: boolean; t: number; swallowed: boolean; shift: boolean }
  | { type: 'click'; x: number; y: number }
  | { type: 'error'; message: string };

const port = (workerData as { port: MessagePort }).port;
const post = (m: FromHook) => parentPort!.postMessage(m);

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const KBD = koffi.struct('KBDLLHOOKSTRUCT', { vkCode: 'uint32', scanCode: 'uint32', flags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
const MSLL = koffi.struct('MSLLHOOKSTRUCT', { x: 'int32', y: 'int32', mouseData: 'uint32', flags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
const MSG = koffi.struct('MSG', { hwnd: 'intptr', message: 'uint32', wParam: 'uintptr', lParam: 'intptr', time: 'uint32', x: 'int32', y: 'int32', lPrivate: 'uint32' });
const HookProc = koffi.proto('__stdcall', 'DictateHookProc', 'intptr', ['int', 'uintptr', 'void *']);
const SetWindowsHookExW = user32.func('__stdcall', 'SetWindowsHookExW', 'void *', ['int', koffi.pointer(HookProc), 'void *', 'uint32']);
const UnhookWindowsHookEx = user32.func('__stdcall', 'UnhookWindowsHookEx', 'bool', ['void *']);
const CallNextHookEx = user32.func('__stdcall', 'CallNextHookEx', 'intptr', ['void *', 'int', 'uintptr', 'void *']);
const GetMessageW = user32.func('__stdcall', 'GetMessageW', 'int', [koffi.out(koffi.pointer(MSG)), 'intptr', 'uint32', 'uint32']);
const GetModuleHandleW = kernel32.func('__stdcall', 'GetModuleHandleW', 'void *', ['str16']);
const GetCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', []);
const PostThreadMessageW = user32.func('__stdcall', 'PostThreadMessageW', 'bool', ['uint32', 'uint32', 'uintptr', 'intptr']);
const MASK_KI = koffi.struct('MASK_KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
const MASK_MI = koffi.struct('MASK_MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
const MASK_INPUT = koffi.struct('MASK_INPUT', { type: 'uint32', u: koffi.union('MASK_INPUT_UNION', { mi: MASK_MI, ki: MASK_KI }) });
const SendInput = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(MASK_INPUT), 'int32']);

/** An unassigned virtual key (the one AutoHotkey uses): pressing it under Alt makes the Alt release "not alone". */
const VK_MASK = 0xe8;

const WH_KEYBOARD_LL = 13;
const WH_MOUSE_LL = 14;
const WM_KEYDOWN = 0x100;
const WM_SYSKEYDOWN = 0x104;
const WM_LBUTTONDOWN = 0x201;
const WM_RBUTTONDOWN = 0x204;

let swallowCombos: Binding[] = [];
let maskKeys = new Set<number>();
const altGr = new AltGrFilter();
let tid = 0;
let capture = false;
let recording = false;
const down = new Set<number>();
/** Keys whose down was swallowed: their up is swallowed too, so the app never sees half a keystroke. */
const swallowedDown = new Set<number>();
const hmod = GetModuleHandleW(null);
let mouseHook: unknown = null;

function shouldSwallow(vk: number): boolean {
  if (capture) {
    if (isModifier(vk)) return false;
    const altOrWin = [VK.LAlt, VK.RAlt, VK.LWin, VK.RWin].some((k) => down.has(k));
    return !altOrWin;
  }
  if (recording && vk === VK.Escape) return true;
  return swallowCombos.some((b) => bindingMatches(b, down));
}

/** Tracks one (filtered) key event; returns whether it is swallowed. */
function track(vk: number, isDown: boolean, t: number): boolean {
  let swallowed = false;
  if (isDown) {
    const repeat = down.has(vk);
    down.add(vk);
    swallowed = repeat ? swallowedDown.has(vk) : shouldSwallow(vk);
    if (swallowed) swallowedDown.add(vk);
    // Injected from the message loop, after this callback returns: still well before the key's release.
    if (!repeat && maskKeys.has(vk)) PostThreadMessageW(tid, WM_APP_MASK, 0, 0);
  } else {
    down.delete(vk);
    swallowed = swallowedDown.delete(vk);
  }
  post({ type: 'key', vk, down: isDown, t, swallowed, shift: down.has(VK.LShift) || down.has(VK.RShift) });
  return swallowed;
}

const keyProc = koffi.register(
  (code: number, wParam: number | bigint, lParam: unknown) => {
    try {
      if (code >= 0) {
        const k = koffi.decode(lParam, KBD) as { vkCode: number; scanCode: number; flags: number; time: number; dwExtraInfo: number | bigint };
        if (Number(k.dwExtraInfo) !== DICTATE_EXTRA) {
          const isDown = Number(wParam) === WM_KEYDOWN || Number(wParam) === WM_SYSKEYDOWN;
          // The fake Left Ctrl of AltGr is dropped here (and still reaches the app); a late-spotted one comes
          // back as a Left Ctrl up before the Right Alt down.
          let swallowed = false;
          for (const e of altGr.feed({ vk: k.vkCode, down: isDown, t: k.time, scan: k.scanCode })) {
            const s = track(e.vk, e.down, k.time);
            if (e.vk === k.vkCode && e.down === isDown) swallowed = s;
          }
          if (swallowed) return 1;
        }
      }
    } catch (err) {
      post({ type: 'error', message: (err as Error).message });
    }
    return CallNextHookEx(null, code, wParam, lParam);
  },
  koffi.pointer(HookProc),
);

const mouseProc = koffi.register(
  (code: number, wParam: number | bigint, lParam: unknown) => {
    if (code >= 0 && (Number(wParam) === WM_LBUTTONDOWN || Number(wParam) === WM_RBUTTONDOWN)) {
      const m = koffi.decode(lParam, MSLL) as { x: number; y: number };
      post({ type: 'click', x: m.x, y: m.y });
    }
    return CallNextHookEx(null, code, wParam, lParam);
  },
  koffi.pointer(HookProc),
);

function apply(m: ToHook): void {
  if (m.type === 'config') {
    swallowCombos = m.swallow;
    maskKeys = new Set(m.mask);
  }
  else if (m.type === 'recording') recording = m.on;
  else if (m.type === 'capture') {
    capture = m.on;
    // Mouse events are only watched while the picker is open: no per-move callbacks otherwise.
    if (m.on && !mouseHook) mouseHook = SetWindowsHookExW(WH_MOUSE_LL, mouseProc, hmod, 0);
    else if (!m.on && mouseHook) {
      UnhookWindowsHookEx(mouseHook);
      mouseHook = null;
    }
  }
}

const hook = SetWindowsHookExW(WH_KEYBOARD_LL, keyProc, hmod, 0);
if (!hook) post({ type: 'error', message: 'SetWindowsHookExW failed' });
else {
  tid = GetCurrentThreadId();
  post({ type: 'ready', tid });
}

function sendMask(): void {
  const ki = (up: boolean) => ({ type: 1, u: { ki: { wVk: VK_MASK, wScan: 0, dwFlags: up ? 2 : 0, time: 0, dwExtraInfo: DICTATE_EXTRA } } });
  SendInput(2, [ki(false), ki(true)], koffi.sizeof(MASK_INPUT));
}

// Blocks in GetMessage (no polling): hook callbacks run inside it. The main thread posts WM_APP_WAKE after
// sending config on `port` (any message wakes it to read the port), and WM_QUIT to stop.
const msg = {} as { message: number };
for (;;) {
  for (let r = receiveMessageOnPort(port); r; r = receiveMessageOnPort(port)) apply(r.message as ToHook);
  const got = GetMessageW(msg, 0, 0, 0);
  if (got <= 0 || msg.message === WM_QUIT) break;
  if (msg.message === WM_APP_MASK) sendMask();
}
UnhookWindowsHookEx(hook);
if (mouseHook) UnhookWindowsHookEx(mouseHook);
