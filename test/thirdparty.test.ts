import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMBERON_GGUF, GEMMA_GGUF } from '../src/core/settings';
import { formatSize, renderThirdPartyMarkdown, THIRD_PARTY } from '../src/core/thirdparty';
import { CLEANUP_ASSETS, SPEECH_ASSET } from '../src/main/downloads';

const byId = (id: string) => {
  const item = THIRD_PARTY.find((t) => t.id === id);
  if (!item) throw new Error(`missing third-party entry ${id}`);
  return item;
};

describe('third-party manifest', () => {
  it('has unique ids and complete fields', () => {
    expect(new Set(THIRD_PARTY.map((t) => t.id)).size).toBe(THIRD_PARTY.length);
    for (const t of THIRD_PARTY) {
      expect(t.name && t.role && t.licence).toBeTruthy();
      expect(t.licenceUrl).toMatch(/^https:\/\//);
      expect(t.source).toMatch(/^https:\/\//);
      if (t.sizeBytes !== undefined) expect(t.downloaded).toBe(true);
    }
  });

  it('matches every downloaded model in downloads.ts byte for byte', () => {
    const emberon = CLEANUP_ASSETS.find((a) => a.name === EMBERON_GGUF);
    const gemma = CLEANUP_ASSETS.find((a) => a.name === GEMMA_GGUF);
    expect(byId('nemotron').sizeBytes).toBe(SPEECH_ASSET.bytes);
    expect(byId('emberon').sizeBytes).toBe(emberon?.bytes);
    expect(byId('gemma').sizeBytes).toBe(gemma?.bytes);
    const sized = THIRD_PARTY.filter((t) => t.sizeBytes !== undefined).map((t) => t.sizeBytes).sort();
    expect(sized).toEqual([SPEECH_ASSET.bytes, ...CLEANUP_ASSETS.map((a) => a.bytes)].sort());
  });

  it('records the required notices and the optional model', () => {
    expect(byId('nemotron').notice).toBe('Licensed by NVIDIA Corporation under the NVIDIA Open Model License');
    expect(byId('emberon').notice).toBe('Powered by Emberon-2 by Promethic Labs');
    expect(byId('gemma').optional).toBe(true);
    expect(byId('emberon').optional).toBe(false);
    expect(byId('llamacpp').downloaded).toBe(true);
    for (const id of ['sherpa-onnx', 'electron', 'koffi', 'uiohook-napi']) expect(byId(id).downloaded).toBe(false);
  });

  it('uses the licences declared by the installed bundled packages', () => {
    const pkgs: Record<string, string> = { 'sherpa-onnx': 'sherpa-onnx-node', electron: 'electron', koffi: 'koffi', 'uiohook-napi': 'uiohook-napi' };
    for (const [id, pkg] of Object.entries(pkgs)) {
      const json = JSON.parse(fs.readFileSync(path.join('node_modules', pkg, 'package.json'), 'utf8')) as { license: string };
      expect(byId(id).licence).toBe(json.license);
    }
  });

  it('formats sizes for display', () => {
    expect(formatSize(463945058)).toBe('464 MB');
    expect(formatSize(199996928)).toBe('200 MB');
    expect(formatSize(3106738272)).toBe('3.1 GB');
  });

  it('THIRD_PARTY.md is generated from the manifest', () => {
    const md = renderThirdPartyMarkdown();
    expect(fs.readFileSync('THIRD_PARTY.md', 'utf8').replace(/\r\n/g, '\n')).toBe(md);
    expect(md).toContain('AGPL-3.0-or-later');
    for (const t of THIRD_PARTY) expect(md).toContain(t.name);
  });
});
