import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "node",

      include: ["tests/**/*.test.ts"],
      exclude: ["node_modules", "dist"],

      coverage: {
        provider: "v8",
        reporter: ["text", "html"],
        reportsDirectory: "./coverage",
        include: ["src/core/**", "src/utils/**"],
        exclude: ["src/ui/**", "src/styles/**"],
        thresholds: {
          lines: 80,
          functions: 80,
          branches: 75,
          statements: 80,
        },
      },

      reporters: ["verbose"],
    },
  }),
);
