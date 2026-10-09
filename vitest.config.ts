import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
    // styles.test.ts reads the stylesheet as text (`?raw`); other CSS stays an empty module.
    css: { include: [/src\/renderer\/src\/styles\.css/] },
  },
});
