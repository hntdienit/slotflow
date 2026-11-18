import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20000,
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
