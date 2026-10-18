// WASAPI capture through koffi's COM vtable calls: shared mode, the device's own mix format, event-driven.
// Runs on the mic worker thread (it blocks in WaitForSingleObject while capturing). Windows only.
import koffi from 'koffi';

const ole32 = koffi.load('ole32.dll');
const kernel32 = koffi.load('kernel32.dll');

const GUID = koffi.struct('WASAPI_GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8) });
const PROPERTYKEY = koffi.struct('WASAPI_PROPERTYKEY', { fmtid: GUID, pid: 'uint32' });
const WFX = koffi.struct('WASAPI_WAVEFORMATEXTENSIBLE', {
  wFormatTag: 'uint16',
  nChannels: 'uint16',
  nSamplesPerSec: 'uint32',
  nAvgBytesPerSec: 'uint32',
  nBlockAlign: 'uint16',
  wBitsPerSample: 'uint16',
  cbSize: 'uint16',
  wValidBitsPerSample: 'uint16',
  dwChannelMask: 'uint32',
  SubFormat: GUID,
});

const CoInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32']);
const CoCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', [koffi.pointer(GUID), 'void *', 'uint32', koffi.pointer(GUID), koffi.out(koffi.pointer('void *'))]);
const CoTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *']);
const PropVariantClear = ole32.func('__stdcall', 'PropVariantClear', 'int32', ['void *']);
const CreateEventW = kernel32.func('__stdcall', 'CreateEventW', 'void *', ['void *', 'bool', 'bool', 'void *']);
const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *']);
const WaitForSingleObject = kernel32.func('__stdcall', 'WaitForSingleObject', 'uint32', ['void *', 'uint32']);

function guid(s: string): Record<string, unknown> {
  const h = s.replace(/[{}-]/g, '');
  const b = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
  return { Data1: Number.parseInt(h.slice(0, 8), 16), Data2: Number.parseInt(h.slice(8, 12), 16), Data3: Number.parseInt(h.slice(12, 16), 16), Data4: [16, 18, 20, 22, 24, 26, 28, 30].map(b) };
}

const CLSID_MMDeviceEnumerator = guid('BCDE0395-E52F-467C-8E3D-C4579291692E');
const IID_IMMDeviceEnumerator = guid('A95664D2-9614-4F35-A746-DE8DB63617E6');
const IID_IAudioClient = guid('1CB9AD4C-DBFA-4C32-B178-C2F568A703B2');
const IID_IAudioClient2 = guid('726778CD-F60A-4EDA-82DE-E47610CD78AA');
const IID_IAudioCaptureClient = guid('C8ADBD64-E71E-48A0-A4DE-185C395CD317');
const DEVPKEY = 'A45C254E-DF1C-4EFD-8020-67D146A850E0';
const PKEY_Device_FriendlyName = { fmtid: guid(DEVPKEY), pid: 14 };
const PKEY_Device_EnumeratorName = { fmtid: guid(DEVPKEY), pid: 24 };

const CLSCTX_ALL = 0x17;
const eCapture = 1;
const eConsole = 0;
const DEVICE_STATE_ACTIVE = 1;
const AUDCLNT_SHAREMODE_SHARED = 0;
const AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
const AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
/** The device was unplugged or disabled (AUDCLNT_E_DEVICE_INVALIDATED). */
export const DEVICE_INVALIDATED = 0x88890004 | 0;

const HR = 'int32';
const P = 'void *';
const OUTP = koffi.out(koffi.pointer('void *'));
const OUT32 = koffi.out(koffi.pointer('uint32'));
const proto = (name: string, args: unknown[]) => koffi.proto('__stdcall', `wasapi_${name}`, HR, [P, ...args] as never);
const T = {
  Release: koffi.proto('__stdcall', 'wasapi_Release', 'uint32', [P]),
  EnumAudioEndpoints: proto('EnumAudioEndpoints', ['int32', 'uint32', OUTP]),
  GetDefaultAudioEndpoint: proto('GetDefaultAudioEndpoint', ['int32', 'int32', OUTP]),
  GetCount: proto('GetCount', [OUT32]),
  Item: proto('Item', ['uint32', OUTP]),
  Activate: proto('Activate', [koffi.pointer(GUID), 'uint32', P, OUTP]),
  OpenPropertyStore: proto('OpenPropertyStore', ['uint32', OUTP]),
  GetId: proto('GetId', [OUTP]),
  GetValue: proto('GetValue', [koffi.pointer(PROPERTYKEY), P]),
  Initialize: proto('Initialize', ['int32', 'uint32', 'int64', 'int64', P, P]),
  GetMixFormat: proto('GetMixFormat', [OUTP]),
  SetClientProperties: proto('SetClientProperties', [P]),
  Start: proto('Start', []),
  Stop: proto('Stop', []),
  SetEventHandle: proto('SetEventHandle', [P]),
  GetService: proto('GetService', [koffi.pointer(GUID), OUTP]),
  GetBuffer: proto('GetBuffer', [OUTP, OUT32, OUT32, P, P]),
  ReleaseBuffer: proto('ReleaseBuffer', ['uint32']),
  GetNextPacketSize: proto('GetNextPacketSize', [OUT32]),
};

/** Calls method `index` of a COM object's vtable. */
function call(obj: unknown, index: number, type: unknown, ...args: unknown[]): number {
  const vtbl = koffi.decode(obj, 'void *');
  const fn = koffi.decode(vtbl, index * koffi.sizeof('void *'), 'void *');
  return koffi.call(fn, type as never, obj, ...args) as number;
}

function check(hr: number, what: string): void {
  if (hr < 0) throw Object.assign(new Error(`${what} failed (0x${(hr >>> 0).toString(16)})`), { hr });
}

function release(obj: unknown): void {
  if (obj) call(obj, 2, T.Release);
}

let enumerator: unknown = null;

/** COM on this thread and the device enumerator, once. */
export function init(): void {
  if (enumerator) return;
  CoInitializeEx(null, 0);
  const out = [null];
  check(CoCreateInstance(CLSID_MMDeviceEnumerator, null, CLSCTX_ALL, IID_IMMDeviceEnumerator, out), 'CoCreateInstance(MMDeviceEnumerator)');
  enumerator = out[0];
}

function stringProp(store: unknown, key: Record<string, unknown>): string {
  const pv = Buffer.alloc(24);
  if (call(store, 5, T.GetValue, key, pv) < 0) return '';
  const vt = pv.readUInt16LE(0);
  // VT_LPWSTR
  const s = vt === 31 ? (koffi.decode(koffi.decode(pv, 8, 'void *'), 'char16_t', -1) as string) : '';
  PropVariantClear(pv);
  return s;
}

export interface Endpoint {
  id: string;
  name: string;
  /** BTHENUM / BTHHFENUM: a Bluetooth headset, which a held-open mic keeps in its call profile. */
  bluetooth: boolean;
  device: unknown;
}

function describe(device: unknown): Endpoint {
  const idOut = [null];
  check(call(device, 5, T.GetId, idOut), 'GetId');
  const id = koffi.decode(idOut[0], 'char16_t', -1) as string;
  CoTaskMemFree(idOut[0]);
  const st = [null];
  let name = '';
  let enumName = '';
  if (call(device, 4, T.OpenPropertyStore, 0, st) >= 0) {
    name = stringProp(st[0], PKEY_Device_FriendlyName);
    enumName = stringProp(st[0], PKEY_Device_EnumeratorName);
    release(st[0]);
  }
  return { id, name, bluetooth: /^BTH/i.test(enumName), device };
}

/** The active capture endpoints. Release each one's `device` (or pass it to open). */
export function endpoints(): Endpoint[] {
  init();
  const col = [null];
  check(call(enumerator, 3, T.EnumAudioEndpoints, eCapture, DEVICE_STATE_ACTIVE, col), 'EnumAudioEndpoints');
  const n = [0];
  call(col[0], 3, T.GetCount, n);
  const out: Endpoint[] = [];
  for (let i = 0; i < n[0]; i++) {
    const d = [null];
    if (call(col[0], 4, T.Item, i, d) >= 0) out.push(describe(d[0]));
  }
  release(col[0]);
  return out;
}

export function defaultEndpoint(): Endpoint {
  init();
  const d = [null];
  check(call(enumerator, 4, T.GetDefaultAudioEndpoint, eCapture, eConsole, d), 'GetDefaultAudioEndpoint');
  return describe(d[0]);
}

export function releaseEndpoint(e: Endpoint): void {
  release(e.device);
}

export interface WasapiStream {
  endpoint: Endpoint;
  rate: number;
  channels: number;
  /** Waits up to `ms` for audio; returns the frames available as mono float samples (possibly empty). */
  read(ms: number): Float32Array;
  close(): void;
}

/** Opens and starts a shared-mode, event-driven capture stream in the device's mix format. Takes over `ep.device`. */
/** Milliseconds spent in each step of the last open(), for the log. */
export const lastOpen = { activate: 0, initialize: 0, start: 0 };

/** Stream options for open(): `raw` skips the driver's capture effects (AUDCLNT_STREAMOPTIONS_RAW); `category` is an AUDIO_STREAM_CATEGORY. */
export interface OpenOptions {
  raw?: boolean;
  category?: number;
}

export function open(ep: Endpoint, startNow = true, opts: OpenOptions = {}): WasapiStream & { start(): void } {
  let t = performance.now();
  const lap = () => {
    const n = performance.now();
    const d = n - t;
    t = n;
    return Math.round(d);
  };
  const ac = [null];
  check(call(ep.device, 3, T.Activate, IID_IAudioClient, CLSCTX_ALL, null, ac), 'Activate(IAudioClient)');
  let client = ac[0];
  if (opts.raw || opts.category !== undefined) {
    // IAudioClient2::SetClientProperties must come before Initialize.
    const c2 = [null];
    check(call(ep.device, 3, T.Activate, IID_IAudioClient2, CLSCTX_ALL, null, c2), 'Activate(IAudioClient2)');
    release(client);
    client = c2[0];
    const props = Buffer.alloc(16);
    props.writeUInt32LE(16, 0);
    props.writeInt32LE(0, 4);
    props.writeInt32LE(opts.category ?? 0, 8);
    props.writeUInt32LE(opts.raw ? 1 : 0, 12);
    check(call(client, 16, T.SetClientProperties, props), 'SetClientProperties');
  }
  lastOpen.activate = lap();
  const fmtOut = [null];
  let event: unknown = null;
  let capture: unknown = null;
  try {
    check(call(client, 8, T.GetMixFormat, fmtOut), 'GetMixFormat');
    const f = koffi.decode(fmtOut[0], WFX) as { wFormatTag: number; nChannels: number; nSamplesPerSec: number; wBitsPerSample: number; SubFormat: { Data1: number } };
    const sub = f.wFormatTag === WAVE_FORMAT_EXTENSIBLE ? f.SubFormat.Data1 : f.wFormatTag;
    const isFloat = sub === WAVE_FORMAT_IEEE_FLOAT && f.wBitsPerSample === 32;
    const isPcm16 = sub === WAVE_FORMAT_PCM && f.wBitsPerSample === 16;
    if (!isFloat && !isPcm16) throw new Error(`unsupported mix format (tag ${f.wFormatTag}, ${f.wBitsPerSample}-bit)`);
    // 20 ms buffer: the engine signals the event every device period (10 ms).
    check(call(client, 3, T.Initialize, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 200_000, 0, fmtOut[0], null), 'IAudioClient.Initialize');
    lastOpen.initialize = lap();
    event = CreateEventW(null, false, false, null);
    check(call(client, 13, T.SetEventHandle, event), 'SetEventHandle');
    const cc = [null];
    check(call(client, 14, T.GetService, IID_IAudioCaptureClient, cc), 'GetService(IAudioCaptureClient)');
    capture = cc[0];
    const startClient = () => {
      lap();
      check(call(client, 10, T.Start), 'IAudioClient.Start');
      lastOpen.start = lap();
    };
    if (startNow) startClient();
    const channels = f.nChannels;
    const rate = f.nSamplesPerSec;
    CoTaskMemFree(fmtOut[0]);
    fmtOut[0] = null;
    let closed = false;
    return {
      start: startClient,
      endpoint: ep,
      rate,
      channels,
      read(ms) {
        WaitForSingleObject(event, ms);
        const parts: Float32Array[] = [];
        let total = 0;
        for (;;) {
          const next = [0];
          check(call(capture, 5, T.GetNextPacketSize, next), 'GetNextPacketSize');
          if (!next[0]) break;
          const data = [null];
          const frames = [0];
          const flags = [0];
          check(call(capture, 3, T.GetBuffer, data, frames, flags, null, null), 'GetBuffer');
          const n = frames[0];
          const mono = new Float32Array(n);
          if (!(flags[0] & AUDCLNT_BUFFERFLAGS_SILENT) && n) {
            // Copied out of the engine's buffer: Electron's V8 memory cage forbids views on outside memory.
            const src = koffi.decode(data[0], koffi.array(isFloat ? 'float' : 'int16', n * channels, 'Typed')) as Float32Array | Int16Array;
            const scale = isFloat ? 1 / channels : 1 / (32768 * channels);
            for (let i = 0; i < n; i++) {
              let s = 0;
              for (let c = 0; c < channels; c++) s += src[i * channels + c];
              mono[i] = s * scale;
            }
          }
          check(call(capture, 4, T.ReleaseBuffer, n), 'ReleaseBuffer');
          parts.push(mono);
          total += n;
        }
        if (parts.length === 1) return parts[0];
        const out = new Float32Array(total);
        let o = 0;
        for (const p of parts) {
          out.set(p, o);
          o += p.length;
        }
        return out;
      },
      close() {
        if (closed) return;
        closed = true;
        call(client, 11, T.Stop);
        release(capture);
        release(client);
        release(ep.device);
        CloseHandle(event);
      },
    };
  } catch (err) {
    if (fmtOut[0]) CoTaskMemFree(fmtOut[0]);
    release(capture);
    release(client);
    if (event) CloseHandle(event);
    throw err;
  }
}

