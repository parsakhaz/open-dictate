// Single source of truth for third-party models and libraries, their licences and required notices.
// Shown in the first-run "Models and licences" step, in Settings > About, and rendered to THIRD_PARTY.md.
// Model sizes duplicate src/main/downloads.ts (src/core must not import src/main); test/thirdparty.test.ts keeps them equal.

export interface ThirdPartyItem {
  id: string;
  name: string;
  /** One short phrase describing what it does in Dictate. */
  role: string;
  /** Display licence name (SPDX identifier where one exists). */
  licence: string;
  licenceUrl: string;
  /** Homepage or repository. */
  source: string;
  /** Download size in bytes, only for downloaded items with a single fixed size. */
  sizeBytes?: number;
  /** Display size when it is not a single fixed number. */
  sizeNote?: string;
  /** Fetched on first run rather than bundled in the app. */
  downloaded: boolean;
  /** Not needed for Dictate to work. */
  optional: boolean;
  /** Attribution line required or requested by the licensor. */
  notice?: string;
}

export const THIRD_PARTY: ThirdPartyItem[] = [
  {
    id: 'nemotron',
    name: 'Nemotron Speech Streaming 0.6B (sherpa-onnx int8 export)',
    role: 'Speech recognition',
    licence: 'NVIDIA Open Model License',
    licenceUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/',
    source: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models',
    sizeBytes: 463945058,
    downloaded: true,
    optional: false,
    notice: 'Licensed by NVIDIA Corporation under the NVIDIA Open Model License',
  },
  {
    id: 'emberon',
    name: 'Emberon-2 (Q4_K_M GGUF) by Promethic Labs',
    role: 'Text cleanup',
    licence: 'LFM Open License v1.0',
    licenceUrl: 'https://huggingface.co/PromethicLabs/Emberon-2/blob/main/LICENSE',
    source: 'https://huggingface.co/PromethicLabs/Emberon-2',
    sizeBytes: 199996928,
    downloaded: true,
    optional: false,
    notice: 'Powered by Emberon-2 by Promethic Labs',
  },
  {
    id: 'gemma',
    name: 'Gemma 4 E2B (Q4_K_M GGUF, unsloth)',
    role: 'Higher-quality text cleanup',
    licence: 'Apache-2.0',
    licenceUrl: 'https://ai.google.dev/gemma/docs/gemma_4_license',
    source: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF',
    sizeBytes: 3106738272,
    downloaded: true,
    optional: true,
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp b11700',
    role: 'Runs the cleanup model',
    licence: 'MIT',
    licenceUrl: 'https://github.com/ggml-org/llama.cpp/blob/master/LICENSE',
    source: 'https://github.com/ggml-org/llama.cpp',
    sizeNote: 'about 12–32 MB depending on platform',
    downloaded: true,
    optional: false,
  },
  {
    id: 'sherpa-onnx',
    name: 'sherpa-onnx',
    role: 'Speech recognition runtime',
    licence: 'Apache-2.0',
    licenceUrl: 'https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE',
    source: 'https://github.com/k2-fsa/sherpa-onnx',
    downloaded: false,
    optional: false,
  },
  {
    id: 'electron',
    name: 'Electron',
    role: 'App framework',
    licence: 'MIT',
    licenceUrl: 'https://github.com/electron/electron/blob/main/LICENSE',
    source: 'https://github.com/electron/electron',
    downloaded: false,
    optional: false,
  },
  {
    id: 'koffi',
    name: 'koffi',
    role: 'Native system calls',
    licence: 'MIT',
    licenceUrl: 'https://github.com/Koromix/koffi/blob/master/LICENSE.txt',
    source: 'https://github.com/Koromix/koffi',
    downloaded: false,
    optional: false,
  },
  {
    id: 'uiohook-napi',
    name: 'uiohook-napi',
    role: 'Global keyboard shortcuts',
    licence: 'MIT',
    licenceUrl: 'https://github.com/SnosMe/uiohook-napi/blob/master/LICENSE',
    source: 'https://github.com/SnosMe/uiohook-napi',
    downloaded: false,
    optional: false,
  },
];

/** Decimal units, as download pages show them: 463945058 -> "464 MB", 3106738272 -> "3.1 GB". */
export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

export function displaySize(item: ThirdPartyItem): string {
  if (item.sizeBytes !== undefined) return formatSize(item.sizeBytes);
  return item.sizeNote ?? '';
}

/** Exact content of THIRD_PARTY.md. */
export function renderThirdPartyMarkdown(): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const link = (text: string, url: string) => `[${cell(text)}](${url})`;
  const models = THIRD_PARTY.filter((t) => t.downloaded);
  const libs = THIRD_PARTY.filter((t) => !t.downloaded);
  const lines = [
    '# Third-party software and models',
    '',
    '<!-- Generated from src/core/thirdparty.ts by renderThirdPartyMarkdown(). Edit that file, not this one. -->',
    '',
    'open-dictate itself is licensed under AGPL-3.0-or-later. The models and the llama.cpp runtime are not part of this repository: you download them from their official sources on first run, and each keeps its own licence.',
    '',
    '## Models (downloaded on first run)',
    '',
    '| Name | Role | Licence | Source | Size |',
    '| --- | --- | --- | --- | --- |',
    ...models.map((t) => `| ${cell(t.name)}${t.optional ? ' (optional)' : ''} | ${cell(t.role)} | ${link(t.licence, t.licenceUrl)} | ${t.source} | ${displaySize(t)} |`),
    '',
    '## Libraries bundled in the app',
    '',
    '| Name | Role | Licence | Source |',
    '| --- | --- | --- | --- |',
    ...libs.map((t) => `| ${cell(t.name)} | ${cell(t.role)} | ${link(t.licence, t.licenceUrl)} | ${t.source} |`),
    '',
    '## Notices',
    '',
    ...THIRD_PARTY.filter((t) => t.notice).map((t) => `- ${t.notice}`),
    '',
  ];
  return lines.join('\n');
}
