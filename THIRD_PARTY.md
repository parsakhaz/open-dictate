# Third-party software and models

<!-- Generated from src/core/thirdparty.ts by renderThirdPartyMarkdown(). Edit that file, not this one. -->

open-dictate itself is licensed under AGPL-3.0-or-later. The models and the llama.cpp runtime are not part of this repository: you download them from their official sources on first run, and each keeps its own licence.

## Models (downloaded on first run)

| Name | Role | Licence | Source | Size |
| --- | --- | --- | --- | --- |
| Nemotron Speech Streaming 0.6B (sherpa-onnx int8 export) | Speech recognition | [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/) | https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models | 464 MB |
| Emberon-2 (Q4_K_M GGUF) by Promethic Labs | Text cleanup | [LFM Open License v1.0](https://huggingface.co/PromethicLabs/Emberon-2/blob/main/LICENSE) | https://huggingface.co/PromethicLabs/Emberon-2 | 200 MB |
| Gemma 4 E2B (Q4_K_M GGUF, unsloth) (optional) | Higher-quality text cleanup | [Apache-2.0](https://ai.google.dev/gemma/docs/gemma_4_license) | https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF | 3.1 GB |
| llama.cpp b11700 | Runs the cleanup model | [MIT](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE) | https://github.com/ggml-org/llama.cpp | about 12–20 MB depending on platform |

## Libraries bundled in the app

| Name | Role | Licence | Source |
| --- | --- | --- | --- |
| sherpa-onnx | Speech recognition runtime | [Apache-2.0](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE) | https://github.com/k2-fsa/sherpa-onnx |
| Electron | App framework | [MIT](https://github.com/electron/electron/blob/main/LICENSE) | https://github.com/electron/electron |
| koffi | Native system calls | [MIT](https://github.com/Koromix/koffi/blob/master/LICENSE.txt) | https://github.com/Koromix/koffi |
| uiohook-napi | Global keyboard shortcuts | [MIT](https://github.com/SnosMe/uiohook-napi/blob/master/LICENSE) | https://github.com/SnosMe/uiohook-napi |

## Notices

- Licensed by NVIDIA Corporation under the NVIDIA Open Model License
- Powered by Emberon-2 by Promethic Labs
