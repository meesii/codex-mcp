import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputDir = join(root, "dist", "ui", "console");
mkdirSync(outputDir, { recursive: true });

await build({
    entryPoints: [join(root, "src", "ui", "console", "app.tsx")],
    outfile: join(outputDir, "app.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    // Radix's scroll-lock styles use get-nonce's standard webpack nonce hook.
    banner: { js: "var __webpack_nonce__ = document.currentScript?.nonce;" },
    plugins: [{
        name: "sonner-csp-nonce",
        setup(builder) {
            builder.onLoad({ filter: /sonner[\\/]dist[\\/]index\.mjs$/ }, ({ path }) => {
                const source = readFileSync(path, "utf8");
                const insertion = "style.type = 'text/css'";
                if (!source.includes(insertion)) throw new Error("Sonner style injection changed; review CSP nonce integration");
                return { contents: source.replace(insertion, `${insertion}\n  if (__webpack_nonce__) style.setAttribute('nonce', __webpack_nonce__)`), loader: "js" };
            });
        },
    }],
});

const tailwindCli = join(root, "node_modules", "@tailwindcss", "cli", "dist", "index.mjs");
execFileSync(process.execPath, [
    tailwindCli,
    "-i", join(root, "src", "ui", "console", "styles.css"),
    "-o", join(outputDir, "app.css"),
    "--minify",
], { stdio: "inherit" });
