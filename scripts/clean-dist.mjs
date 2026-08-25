import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const distPath = join(repositoryRoot, "dist");

if (dirname(distPath) !== repositoryRoot.replace(/[\\/]$/, "")) {
    throw new Error(`Refusing to clean unexpected build directory: ${distPath}`);
}

rmSync(distPath, { recursive: true, force: true });
