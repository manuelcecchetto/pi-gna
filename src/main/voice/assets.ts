// What voice calls download, pinned: a llama.cpp server build with /v1/realtime and /tts for LFM3 (b11960 and newer),
// the LFM3-Audio-2B model and its audio projector. All are checked against these SHA-256s (GitHub's asset digests,
// the Hub's LFS object ids) before use. Autocomplete pins its own, older build: moving it is its own change.

import type { Download, ServerBuild } from "../autocomplete/assets";

const LLAMA = "b11969";
const build = (variant: string, ext: string, size: number, sha256: string): ServerBuild => ({
  id: `${LLAMA}-${variant}`,
  url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA}/llama-${LLAMA}-bin-${variant}.${ext}`,
  size,
  sha256,
});

/** The builds to try on each platform, best first, as for autocomplete. */
export const SERVER_BUILDS: Readonly<Record<string, readonly ServerBuild[]>> = {
  "darwin-arm64": [build("macos-arm64", "tar.gz", 16464475, "c61442b1b4a29607bbaf543068a9fdeac08a74bea5181aa44a14464e39b18f13")],
  "darwin-x64": [build("macos-x64", "tar.gz", 12207739, "bbe5d6a3e8caf7acd9a4f0775b8df53688e8b5300310077441c14eba6bcaf7d3")],
  "win32-x64": [
    build("win-vulkan-x64", "zip", 37346743, "bc0c860370f38958fa62b487ed012eeb326f31135acffed61adbc08da0b537fa"),
    build("win-cpu-x64", "zip", 24408368, "f3cc2c9ab938ad76b6a4bc9eeb8f81cb25455ab291736ee767360758112fa672"),
  ],
  "win32-arm64": [
    build("win-vulkan-arm64", "zip", 25550026, "cef5bad1b592375dd58b2167f0d2794989029abe3099918293472d0289721025"),
    build("win-cpu-arm64", "zip", 13020604, "d89d1543940dffc287d5fec98fd5f91c1c7330432fa1033c2a5ce2384f01fdad"),
  ],
  "linux-x64": [
    build("ubuntu-vulkan-x64", "tar.gz", 35475226, "6bd59b750cab59149dd751f5bff0dd5147930684b97a3093482450f1eeb569e8"),
    build("ubuntu-x64", "tar.gz", 22691955, "ad8b3af2ec3201cd21287e4d457356ccd486ea23410fb7f7d8238b3dd82464d6"),
  ],
  "linux-arm64": [build("ubuntu-arm64", "tar.gz", 18427298, "895dd6d72d8f71e1946dae11bc981df53efb67c2902b64c92e28a3bbe82dc9ab")],
};

const HUB = "https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF/resolve/642697a5597a675cb819ed236ac415c1e60a4f6f";

/**
 * LiquidAI/LFM3-Audio-2B (LFM Open License v1.0: free below $10M yearly revenue), Q4_K_M: hears speech, calls tools
 * and speaks, 18 languages. On an M2 it answered 0.6-0.75 s after the end of speech streamed in at speaking pace, and
 * spoke at about 0.7x real time (docs/DESIGN.md, Voice calls).
 */
export const MODEL: Download & { file: string } = {
  file: "LFM3-Audio-2B-Q4_K_M.gguf",
  url: `${HUB}/LFM3-Audio-2B-Q4_K_M.gguf`,
  size: 1099626016,
  sha256: "9a773289bd321ed879cd3a76545f6aca506e403851a45fb315420aee45625be2",
};

/** The audio encoder and codec the model hears and speaks with. */
export const PROJECTOR: Download & { file: string } = {
  file: "mmproj-LFM3-Audio-2B-Q8_0.gguf",
  url: `${HUB}/mmproj-LFM3-Audio-2B-Q8_0.gguf`,
  size: 337862080,
  sha256: "26601e904245a85bd8f3cf320a629e897cfc01c1d09369e8b4fd951f13024d3e",
};

export const serverBuilds = (platform: string = process.platform, arch: string = process.arch): readonly ServerBuild[] => SERVER_BUILDS[`${platform}-${arch}`] ?? [];
