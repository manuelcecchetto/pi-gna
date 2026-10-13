// What dictation downloads, pinned: transcribe.cpp's native library for this computer, Koffi's Node addon that calls
// into it, and the speech model. All are checked against these SHA-256s (GitHub's asset digests; for the npm tarballs
// and the model, the hash of the file itself, which for the model is also the Hub's LFS object id) before use.
// The transcribe.cpp release must match the `transcribe-cpp` binding in package.json (its ABI check refuses others),
// and the Koffi addon the version that binding depends on.

import type { Download } from "../autocomplete/assets";
import type { Archive } from "../autocomplete/install";

export interface DictationRuntime {
  /** transcribe.cpp's library and ggml backends, and the library's file name in it. */
  native: Archive & { library: string };
  /** Koffi's addon for this platform, and its path inside the npm tarball. */
  koffi: Archive & { addon: string };
}

const TRANSCRIBE = "0.4.0";
const KOFFI = "3.3.3";

const native = (tuple: string, library: string, size: number, sha256: string): DictationRuntime["native"] => ({
  id: `transcribe-${TRANSCRIBE}-${tuple}`,
  url: `https://github.com/handy-computer/transcribe.cpp/releases/download/v${TRANSCRIBE}/transcribe-native-${TRANSCRIBE}-${tuple}.tar.gz`,
  size,
  sha256,
  library,
});

const koffi = (platform: string, size: number, sha256: string): DictationRuntime["koffi"] => ({
  id: `koffi-${KOFFI}-${platform}`,
  url: `https://registry.npmjs.org/@koromix/koffi-${platform}/-/koffi-${platform}-${KOFFI}.tgz`,
  size,
  sha256,
  addon: `package/${platform.replace("-", "_")}/koffi.node`,
});

/**
 * One runtime per platform transcribe.cpp builds for. The Linux and Windows libraries carry Vulkan and CPU backends
 * and pick at load; the Intel Mac one is CPU only. No Windows on Arm build exists.
 */
export const RUNTIMES: Readonly<Record<string, DictationRuntime>> = {
  "darwin-arm64": {
    native: native("macos-arm64-metal", "libtranscribe.dylib", 2475842, "eeae15ef08cfbfdd059238765a1a0f790dd39e2f0fdb05bfbb601e183286f6d7"),
    koffi: koffi("darwin-arm64", 409177, "6195d71398107c38a74c39c416905d5ae61625709f2ac2da09d06bdac40b84fd"),
  },
  "darwin-x64": {
    native: native("macos-x86_64-cpu", "libtranscribe.dylib", 1600612, "e4da34c9cebd8b31ca2c1049296430ff7af1a851db436e23e08d3d66e09b7d0f"),
    koffi: koffi("darwin-x64", 455829, "67e0ff5067d46429227dd9c70b107519c864d24cd5cc701884d3bda4a08dc1a5"),
  },
  "linux-x64": {
    native: native("linux-x86_64-cpu-vulkan", "libtranscribe.so", 22546161, "f229adb9018bb7e33042137f92942022a5d76bfc5e16efd7a11cc9b115e86ea2"),
    koffi: koffi("linux-x64", 603661, "ea8e7d52314cd19711af798c35016d5e40f30bd68c7289b22b849b9575d099af"),
  },
  "linux-arm64": {
    native: native("linux-aarch64-cpu-vulkan", "libtranscribe.so", 18122209, "af7ee108923b74d3e727309ce4992714a25872ea77c6247da8be9a0ed54275dd"),
    koffi: koffi("linux-arm64", 603752, "de78b1e65e4a5149610e89d5053bc2a2ad0754cde75ea2120b22735282936694"),
  },
  "win32-x64": {
    native: native("windows-x86_64-cpu-vulkan", "transcribe.dll", 18036555, "9d5bd89f720d7979323e73f5220fe50fad5e38a7b0c2525225d453bd09adf2b0"),
    koffi: koffi("win32-x64", 400702, "6f3601e24e865ede500dad7fefdc545bf305862185430ecd078ffca4c2962da4"),
  },
};

/**
 * moondream/parakeet-ultra (CC-BY-4.0), a fine-tune of NVIDIA's Parakeet-TDT-0.6B-v3: 25 European languages with
 * punctuation and language detection. In transcribe.cpp's catalog it has the lowest FLEURS error of any model under
 * 1 GB in English, Italian and German, at about 200x real time on an M4. The Q5_K_M quant is handy-computer's,
 * WER-checked against the original.
 */
export const MODEL: Download & { file: string } = {
  file: "parakeet-ultra-Q5_K_M.gguf",
  url: "https://huggingface.co/handy-computer/parakeet-ultra-gguf/resolve/39eeb55181f0d354fd934f06e92fd8d5037fed8e/parakeet-ultra-Q5_K_M.gguf",
  size: 549800864,
  sha256: "f6e3d8172547a3bb468e92ff395696e6d2e0371a9e52690a27741b4e8561c997",
};

export const dictationRuntime = (platform: string = process.platform, arch: string = process.arch): DictationRuntime | undefined => RUNTIMES[`${platform}-${arch}`];
