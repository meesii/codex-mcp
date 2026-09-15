import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";

const repositoryRoot = fileURLToPath(new URL("./", import.meta.url));
const entry = fileURLToPath(new URL("./src/ui/console/main.ts", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/ui/console", import.meta.url));

export default defineConfig({
    root: repositoryRoot,
    logLevel: "silent",
    plugins: [
        vue(),
        Components({
            dts: false,
            resolvers: [ElementPlusResolver({ importStyle: "css" })],
        }),
    ],
    define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: {
        outDir,
        emptyOutDir: true,
        target: "es2022",
        minify: "esbuild",
        cssCodeSplit: false,
        lib: {
            entry,
            name: "CodexMcpConsole",
            formats: ["iife"],
            fileName: () => "app.js",
        },
        rollupOptions: {
            output: {
                assetFileNames: (assetInfo) => assetInfo.names?.some((name) => name.endsWith(".css")) ? "app.css" : "[name][extname]",
            },
        },
    },
});
