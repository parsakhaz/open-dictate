// Upstream release digests pinned on 2026-10-18 (llama.cpp Vulkan builds on 2026-10-19). Updates require a new reviewed manifest.
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
    "name": "llama-b11700-bin-ubuntu-vulkan-arm64.tar.gz",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11700/llama-b11700-bin-ubuntu-vulkan-arm64.tar.gz",
    "bytes": 24230064,
    "sha256": "a270ba756019220b2153943b3a11d340ba163282e9f252d1a4cc720271474891"
  },
  {
    "name": "llama-b11700-bin-ubuntu-vulkan-x64.tar.gz",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11700/llama-b11700-bin-ubuntu-vulkan-x64.tar.gz",
    "bytes": 30536818,
    "sha256": "7a72ae05c3054077a90a4d33d1079271cf2360a20019927d147feaa9be647983"
  },
  {
    "name": "llama-b11700-bin-win-vulkan-arm64.zip",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11700/llama-b11700-bin-win-vulkan-arm64.zip",
    "bytes": 24862240,
    "sha256": "a0e35ae761c847edb7c6da0e02f8cc02c3ba463836d5f503919caa5f7c11f933"
  },
  {
    "name": "llama-b11700-bin-win-vulkan-x64.zip",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11700/llama-b11700-bin-win-vulkan-x64.zip",
    "bytes": 32240958,
    "sha256": "d93ccad5992d6640d7081407c24d3ceddf717bc0a1c3c269225c9bef0182f83e"
  }
];
