import { describe, expect, it } from 'vitest';
import { DEFAULT_POINT, parsePoint } from '../src/core/sections/point';
import {
  CAPTURE_MAX_AGE_MS,
  captureName,
  countdown,
  intersect,
  isExcluded,
  MASK,
  MAX_TEXT,
  parseElement,
  pointMessage,
  prepareText,
  regionFrom,
  reviewCommand,
  staleCaptures,
  targetLabel,
  targetRect,
  type UiaElement,
} from '../src/core/pointsay';

const el = (o: Partial<UiaElement> = {}): UiaElement => ({ name: 'Pay now', role: 'button', rect: { x: 100, y: 200, width: 80, height: 30 }, text: 'Pay now', pid: 42, process: 'App.exe', window: 'Checkout', ...o });

describe('point and say: the helper element', () => {
  it('keeps a well-formed element and caps its strings', () => {
    const e = parseElement({ name: 'x'.repeat(1000), role: 'button', rect: { x: 1.4, y: 2, width: 3, height: 4 }, text: 'hi', pid: 7, process: 'a.exe', window: 'w' });
    expect(e?.name.length).toBe(300);
    expect(e?.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it('refuses an element without a usable rectangle, or anything that is not an object', () => {
    expect(parseElement({ name: 'a', rect: { x: 0, y: 0, width: 0, height: 5 } })).toBeNull();
    expect(parseElement({ name: 'a', rect: { x: 'a', y: 0, width: 5, height: 5 } })).toBeNull();
    expect(parseElement(null)).toBeNull();
    expect(parseElement('button')).toBeNull();
  });
});

describe('point and say: excluded apps', () => {
  it('matches process names ignoring case and a missing .exe', () => {
    expect(isExcluded('KeePassXC.exe', DEFAULT_POINT.excludedApps)).toBe(true);
    expect(isExcluded('keepassxc.EXE', ['KeePassXC'])).toBe(true);
    expect(isExcluded('Code.exe', DEFAULT_POINT.excludedApps)).toBe(false);
  });

  it('never treats an unknown process as excluded by accident', () => {
    expect(isExcluded('', ['', '.exe'])).toBe(false);
  });
});

describe('point and say: regions and crops', () => {
  it('a short drag is still a point; a longer one is a region either way round', () => {
    expect(regionFrom({ x: 10, y: 10 }, { x: 15, y: 18 })).toBeNull();
    expect(regionFrom({ x: 500, y: 400 }, { x: 88, y: 164 })).toEqual({ x: 88, y: 164, width: 412, height: 236 });
  });

  it('intersects with the display, or gives nothing', () => {
    expect(intersect({ x: -10, y: -10, width: 30, height: 30 }, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 20, height: 20 });
    expect(intersect({ x: 200, y: 0, width: 30, height: 30 }, { x: 0, y: 0, width: 100, height: 100 })).toBeNull();
  });

  it('pads an element by a few pixels, and keeps a region as dragged', () => {
    expect(targetRect({ kind: 'element', el: el() })).toEqual({ x: 96, y: 196, width: 88, height: 38 });
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    expect(targetRect({ kind: 'region', rect })).toBe(rect);
  });

  it('labels what is pointed at', () => {
    expect(targetLabel({ kind: 'element', el: el({ role: 'dialog', name: 'Unhandled  exception' }) })).toBe('Dialog · Unhandled exception');
    expect(targetLabel({ kind: 'element', el: el({ role: '', name: '' }) })).toBe('Element');
    expect(targetLabel({ kind: 'region', rect: { x: 0, y: 0, width: 412, height: 236 } })).toBe('Region · 412 × 236');
    expect(targetLabel({ kind: 'around', rect: { x: 0, y: 0, width: 1, height: 1 } })).toBe('Area around the pointer');
  });
});

describe('point and say: the text read there', () => {
  it('masks a planted key and keeps its prefix, counting it', () => {
    // A made-up key, put together here so secret scanners don't take the source for a leak.
    const fake = ['sk', 'live', '51HxQa2Rk7VbT9abcdef'].join('-');
    const r = prepareText(`POST /api/cart/quote 500\nAuthorization: Bearer ${fake}`);
    expect(r.text).toContain(`Bearer sk-live-${MASK}`);
    expect(r.text).not.toContain('51HxQa2Rk7VbT9');
    expect(r.secrets).toBe(1);
  });

  it('masks what history redacts too (a token pair, a card number)', () => {
    const r = prepareText('token=abcd1234efgh card 4111 1111 1111 1111');
    expect(r.text).toBe(`token=${MASK} card ${MASK}`);
    expect(r.secrets).toBe(2);
  });

  it('squeezes blank runs and cuts very long text', () => {
    expect(prepareText('a  \r\n\r\n\r\n\r\nb').text).toBe('a\n\nb');
    const long = prepareText('word '.repeat(2000));
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(MAX_TEXT);
  });
});

describe('point and say: the message', () => {
  it('puts the words first, then the target, the text and the crop', () => {
    const m = pointMessage({ words: 'fix this', label: 'Dialog · Unhandled exception', app: 'msedge.exe', window: 'Checkout', text: 'boom', file: 'C:\\c\\point-1.png', size: { width: 471, height: 251 } });
    expect(m).toBe(['fix this', '', 'Pointed at: Dialog · Unhandled exception in msedge.exe, "Checkout"', 'Text read there (secrets masked):', '"""', 'boom', '"""', 'Screenshot (471 × 251): C:\\c\\point-1.png'].join('\n'));
  });

  it('leaves out what a region has none of', () => {
    const m = pointMessage({ words: 'this', label: 'Region · 4 × 4', app: '', window: '', text: '', file: 'f.png', size: { width: 4, height: 4 } });
    expect(m).toBe('this\n\nPointed at: Region · 4 × 4\nScreenshot (4 × 4): f.png');
  });
});

describe('point and say: the review', () => {
  it('counts down only while running', () => {
    expect(countdown(3000, 100, true)).toBe(2900);
    expect(countdown(3000, 100, false)).toBe(3000);
    expect(countdown(50, 100, true)).toBe(0);
  });

  it('reads send and cancel, and nothing else', () => {
    expect(reviewCommand('Send it.')).toBe('send');
    expect(reviewCommand('go ahead')).toBe('send');
    expect(reviewCommand('Cancel')).toBe('cancel');
    expect(reviewCommand("don't send it")).toBe('cancel');
    expect(reviewCommand('send it to billing')).toBeNull();
  });
});

describe('point and say: captures on disk', () => {
  it('deletes only its own captures older than a day', () => {
    const now = 10 * CAPTURE_MAX_AGE_MS;
    const old = now - CAPTURE_MAX_AGE_MS - 1;
    expect(staleCaptures([{ name: 'point-a.png', mtimeMs: old }, { name: 'point-b.png', mtimeMs: now - 1000 }, { name: 'peek-c.png', mtimeMs: old }, { name: 'point-d.txt', mtimeMs: old }], now)).toEqual(['point-a.png']);
  });

  it('names a capture by time, safe for any file system', () => {
    expect(captureName(Date.UTC(2026, 9, 19, 14, 32, 5, 7), 3)).toBe('point-2026-10-19T14-32-05-007Z-3.png');
  });
});

describe('point and say: settings', () => {
  it('has no key by default, and an old profile gets the defaults', () => {
    expect(DEFAULT_POINT.key).toBeNull();
    expect(parsePoint(undefined)).toEqual(DEFAULT_POINT);
    expect(parsePoint({ excludedApps: ['ok.exe', 'C:\\bad\\path.exe', 'ok.exe'] }).excludedApps).toEqual(['ok.exe']);
  });
});
