// What composer autocomplete downloads, pinned: a llama.cpp server build for this computer and the typeahead model.
// Both are checked against these SHA-256s (GitHub's asset digests, Hugging Face's LFS object ids) before use.
// To move a pin, take the new release's digests from the GitHub API and the model's from the Hub's tree API.

export interface Download {
  url: string;
  size: number;
  sha256: string;
}

/** One llama.cpp build: its archive and the folder name it unpacks into under userData/autocomplete/server. */
export interface ServerBuild extends Download {
  id: string;
}

const LLAMA = "b11553";
const build = (variant: string, ext: string, size: number, sha256: string): ServerBuild => ({
  id: `${LLAMA}-${variant}`,
  url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA}/llama-${LLAMA}-bin-${variant}.${ext}`,
  size,
  sha256,
});

/**
 * The builds to try on each platform, best first: a GPU build (Metal on a Mac, Vulkan on Windows and Linux), then
 * the CPU build for a computer without a working Vulkan driver.
 */
export const SERVER_BUILDS: Readonly<Record<string, readonly ServerBuild[]>> = {
  "darwin-arm64": [build("macos-arm64", "tar.gz", 12086220, "95ba87421fd1fa0b494b84a2fc92e4a22e4caa86b4f5ce4d8c6f9d4e9c363e12")],
  "darwin-x64": [build("macos-x64", "tar.gz", 11614984, "d75640a019922a38121b0f2b00cbdf7ee91a8f1edeb1c61b8f225509ee344e46")],
  "win32-x64": [
    build("win-vulkan-x64", "zip", 33473974, "fd9b554903bf55d696f60c86e259027608cb67ebd2f632c3684cdcda044d7380"),
    build("win-cpu-x64", "zip", 19528223, "5b1d1648f176d981a22e45e069eb52732437f824ea6a6159ca78e4a4bf792b07"),
  ],
  "win32-arm64": [
    build("win-vulkan-arm64", "zip", 26029345, "c6febe75a1e230852a78f49448825dbb8f427fcf14eef25a6703a5aaa69ea660"),
    build("win-cpu-arm64", "zip", 12353653, "be8a8079dc3ea229a7fb9e65e8b4f4e85e22be72c9c6d8304595a1f7ff5a7788"),
  ],
  "linux-x64": [
    build("ubuntu-vulkan-x64", "tar.gz", 31790047, "273828882608741a3ec065443176b5ed4922406744077d9da03821966cf7d496"),
    build("ubuntu-x64", "tar.gz", 17824160, "1fd58faf9f3740dad350fdba21b1afd4a393f9140d9ed8d68c6279820a4d25e3"),
  ],
  "linux-arm64": [build("ubuntu-arm64", "tar.gz", 13812486, "2f79bfc785f7284434dd5506470d12055b24ccc34707cdbabe1b1733aa8f83c1")],
};

/**
 * chartreuse-verte/orb-human-typeahead-350m-v1.2 (Apache-2.0): a full fine-tune of IBM's granite-4.0-350m-base that
 * predicts the person's next words in a chat. In the bake-off it matched Qwen3.5-0.8B-Base at half the latency and
 * half the download.
 */
export const MODEL: Download & { file: string } = {
  file: "orb-human-typeahead-350m-v1.2-Q8_0.gguf",
  url: "https://huggingface.co/chartreuse-verte/orb-human-typeahead-350m-v1.2/resolve/fbbe4733cdb00bcf2f6b17f92637c83a8b6732a7/GGUF/orb-human-typeahead-350m-v1.2-Q8_0.gguf",
  size: 378130720,
  sha256: "c5ceff7b7ed45bdef1424b4de39d5369f96f7cd2cf590729f7843b0fe90d44c3",
};

export const serverBuilds = (platform: string = process.platform, arch: string = process.arch): readonly ServerBuild[] => SERVER_BUILDS[`${platform}-${arch}`] ?? [];
