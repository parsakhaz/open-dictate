// Upstream release digests pinned on 2026-10-18. Updates require a new reviewed manifest.
// Sources: github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models, ggml-org/llama.cpp/releases/tag/b11700,
// huggingface.co/PromethicLabs/Emberon-2 and huggingface.co/unsloth/gemma-4-E2B-it-GGUF.
import { EMBERON_GGUF, GEMMA_GGUF, STT_MODEL } from '../core/settings';

export interface DownloadAsset { name: string; url: string; bytes: number; sha256: string }
/** Exact sizes from the verified int8 archive; detect an interrupted/manual extraction at startup. */
export const SPEECH_FILES: Record<string, number> = {
  'encoder.int8.onnx': 652916852,
  'decoder.int8.onnx': 7257753,
  'joiner.int8.onnx': 1735862,
  'tokens.txt': 8952,
};
export const SPEECH_ASSET: DownloadAsset = {
  name: `${STT_MODEL}.tar.bz2`,
  url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${STT_MODEL}.tar.bz2`,
  bytes: 463945058,
  sha256: '840c48deed02d4a5975716e7b12dc0a8b1ba620776c6366f7e5677d8907edd73',
};
export const CLEANUP_ASSETS: DownloadAsset[] = [
  { name: EMBERON_GGUF, url: 'https://huggingface.co/PromethicLabs/Emberon-2/resolve/d9b5cf07c0cb5d44711011e9d41c072c709d3af2/Emberon-2-Q4_K_M.gguf', bytes: 199996928, sha256: '18fead8b8df3808ed47a84cd41a5a0617e3374d1a62dd52e3ba4bfb839810ffd' },
  { name: GEMMA_GGUF, url: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf', bytes: 3106738272, sha256: '740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8' },
];

export const LLAMA_ASSETS: DownloadAsset[] = [
  {
    "name": "llama-b11700-bin-macos-arm64.tar.gz",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11700/llama-b11700-bin-macos-arm64.tar.gz",
    "bytes": 12231542,
    "sha256": "75d795f8826e09893d44e040742ca5dd604d9402dc40393aed0aea6866aadd73"
  },
  {
    "name": "llama-b11700-bin-macos-x64.tar.gz",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11700/llama-b11700-bin-macos-x64.tar.gz",
    "bytes": 11715425,
    "sha256": "957911e205758c5ffc5e835e631dd428ba7a46c91f8824e3a3e1a2f107aa7c79"
  },
  {
    "name": "llama-b11700-bin-ubuntu-arm64.tar.gz",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11700/llama-b11700-bin-ubuntu-arm64.tar.gz",
    "bytes": 13941475,
    "sha256": "375b442c3373df5929b3ebf9260d0b955e341bd86bda4e3be9d4cb8a0edd633e"
  },
  {
    "name": "llama-b11700-bin-ubuntu-x64.tar.gz",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11700/llama-b11700-bin-ubuntu-x64.tar.gz",
    "bytes": 17891256,
    "sha256": "51842656431fc20928123e0c88598f7604a2fe2031fb4e7d45943316817de024"
  },
  {
    "name": "llama-b11700-bin-win-cpu-arm64.zip",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11700/llama-b11700-bin-win-cpu-arm64.zip",
    "bytes": 12484011,
    "sha256": "97d76ec70354f070e122954ffdb0912dca37efe9e3d85b1b164c39c9c55a9a7d"
  },
  {
    "name": "llama-b11700-bin-win-cpu-x64.zip",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11700/llama-b11700-bin-win-cpu-x64.zip",
    "bytes": 19593035,
    "sha256": "4e2af6b2b39691cd84267a02839596ed6653ea2dde5ee9cdbfeb4dd9677eecbb"
  }
];
