import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_VERSION = loadPackageVersion();

function loadPackageVersion(): string {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const packagePath = resolve(here, "..", "..", "package.json");
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
        return typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
}
