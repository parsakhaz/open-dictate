// The real clipboard: dictate's text carries Windows' privacy formats (B1). It replaces whatever is on the
// clipboard, so it runs only with DICTATE_CLIPBOARD_TESTS=1 (set in CI), never by default on someone's PC.
import { beforeAll, describe, expect, it } from 'vitest';

async function nativeClipboard() {
  const { default: koffi } = await import('koffi');
  const { writeClipboardText } = await import('../src/native/win32');

  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const OpenClipboard = user32.func('__stdcall', 'OpenClipboard', 'bool', ['intptr']);
  const CloseClipboard = user32.func('__stdcall', 'CloseClipboard', 'bool', []);
  const EnumClipboardFormats = user32.func('__stdcall', 'EnumClipboardFormats', 'uint32', ['uint32']);
  const GetClipboardFormatNameW = user32.func('__stdcall', 'GetClipboardFormatNameW', 'int', ['uint32', 'void *', 'int']);
  const GetClipboardData = user32.func('__stdcall', 'GetClipboardData', 'intptr', ['uint32']);
  const GlobalLock = kernel32.func('__stdcall', 'GlobalLock', 'void *', ['intptr']);
  const GlobalUnlock = kernel32.func('__stdcall', 'GlobalUnlock', 'bool', ['intptr']);
  const GlobalSize = kernel32.func('__stdcall', 'GlobalSize', 'uintptr', ['intptr']);

  /** The clipboard's text and its registered formats, each with its first DWORD. */
  function readBack(): { text: string; formats: Record<string, number> } {
    if (!OpenClipboard(0)) throw new Error('clipboard busy');
    try {
      const formats: Record<string, number> = {};
      let text = '';
      for (let f = EnumClipboardFormats(0); f; f = EnumClipboardFormats(f)) {
        const read = (): Buffer => {
          const h = GetClipboardData(f);
          const n = Number(GlobalSize(h));
          const p = GlobalLock(h);
          const buf = Buffer.from(koffi.decode(p, koffi.array('uint8', n)) as number[]);
          GlobalUnlock(h);
          return buf;
        };
        if (f === 13) text = read().toString('utf16le').replace(/\0+$/, '');
        const name = Buffer.alloc(512);
        const len = GetClipboardFormatNameW(f, name, 256);
        if (len > 0) formats[name.toString('utf16le', 0, len * 2)] = read().readUInt32LE(0);
      }
      return { text, formats };
    } finally {
      CloseClipboard();
    }
  }

  return { writeClipboardText, readBack };
}

describe.skipIf(process.platform !== 'win32' || !process.env.DICTATE_CLIPBOARD_TESTS)('clipboard privacy formats (real clipboard)', () => {
  let native: Awaited<ReturnType<typeof nativeClipboard>>;
  beforeAll(async () => { native = await nativeClipboard(); });
  it('a transient paste is kept out of Win+V history, clipboard monitors and the cloud', async () => {
    await native.writeClipboardText('dictated – text ✓', { history: false });
    const r = native.readBack();
    expect(r.text).toBe('dictated – text ✓');
    expect(r.formats).toMatchObject({ CanUploadToCloudClipboard: 0, CanIncludeInClipboardHistory: 0, ExcludeClipboardContentFromMonitorProcessing: 0 });
  });

  it('text the person keeps stays in Win+V history but never syncs to the cloud', async () => {
    await native.writeClipboardText('kept', { history: true });
    const r = native.readBack();
    expect(r.text).toBe('kept');
    expect(r.formats).toMatchObject({ CanUploadToCloudClipboard: 0 });
    expect(r.formats).not.toHaveProperty('CanIncludeInClipboardHistory');
    expect(r.formats).not.toHaveProperty('ExcludeClipboardContentFromMonitorProcessing');
  });
});
