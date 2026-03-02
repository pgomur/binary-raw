import { defineConfig, type UserConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

const r = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@core": r("./src/core"),
      "@ui": r("./src/ui"),
      "@app-types": r("./src/types"),
      "@utils": r("./src/utils"),
    },
  },

  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
    minify: "esbuild",
    cssCodeSplit: true,
    assetsInlineLimit: 4_096,

    rollupOptions: {
      output: {
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },

  server: {
    port: 5173,
    open: true,
    strictPort: true,
  },
} satisfies UserConfig);
