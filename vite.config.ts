import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { build as viteBuild, defineConfig, loadEnv, type Plugin } from "vite";
import { applyClerkManifestEnv } from "./src/build/manifestConfig";

/**
 * Content scripts registered at document_start (the network shim + its bridge,
 * see src/tools/networkCapture/pageShimCapture.ts) are loaded by Chrome as plain
 * files, NOT ES modules — they cannot resolve sibling import chunks. The main
 * build code-splits shared modules (shimInjection is shared with the service
 * worker), so we build each content entry separately as a single self-contained
 * IIFE written to a stable dist/content/ path.
 */
function contentScriptsPlugin(): Plugin {
  return {
    name: "content-scripts-plugin",
    apply: "build",
    async closeBundle() {
      const entries: Array<{ name: string; input: string }> = [
        { name: "netShimMain", input: "src/content/netShimMain.ts" },
        { name: "netShimBridge", input: "src/content/netShimBridge.ts" }
      ];
      for (const entry of entries) {
        await viteBuild({
          configFile: false,
          logLevel: "warn",
          // Don't re-copy public/ assets into the content output.
          publicDir: false,
          build: {
            emptyOutDir: false,
            outDir: "dist/content",
            copyPublicDir: false,
            rollupOptions: {
              input: path.resolve(__dirname, entry.input),
              output: {
                format: "iife",
                entryFileNames: `${entry.name}.js`
              }
            }
          }
        });
      }
    }
  };
}

function extensionManifestPlugin(clerkFrontendApi?: string, crxPublicKey?: string): Plugin {
  return {
    name: "extension-manifest-plugin",
    apply: "build",
    closeBundle() {
      const manifestPath = path.resolve(__dirname, "dist/manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const nextManifest = applyClerkManifestEnv(manifest, {
        clerkFrontendApi,
        crxPublicKey
      });

      fs.writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const clerkFrontendApi = env.CLERK_FRONTEND_API || env.VITE_CLERK_FRONTEND_API;
  const crxPublicKey = env.CRX_PUBLIC_KEY || env.VITE_CRX_PUBLIC_KEY;

  return {
    plugins: [react(), extensionManifestPlugin(clerkFrontendApi, crxPublicKey), contentScriptsPlugin()],
    build: {
      sourcemap: env.VITE_SOURCEMAP === "1",
      rollupOptions: {
        input: {
          sidepanel: "src/app/index.html",
          imageViewer: "src/image-viewer/index.html",
          serviceWorker: "src/background/serviceWorker.ts"
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === "serviceWorker" ? "background/serviceWorker.js" : "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]"
        }
      },
      outDir: "dist",
      emptyOutDir: true
    }
  }
});
