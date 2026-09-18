import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { unzip } from "fflate";

/**
 * Extract a zip archive into `destDir` without following or creating symlinks.
 *
 * @param zipPath Path to the zip file.
 * @param destDir Directory that extracted files must stay inside.
 * @returns Nothing. Throws if an entry would escape `destDir`.
 */
export async function extractZipFile(zipPath: string, destDir: string): Promise<void> {
    const bytes = new Uint8Array(await readFile(zipPath));
    const files = await unzipEntries(bytes);
    const destRoot = resolve(destDir);

    for (const [entryName, content] of Object.entries(files)) {
        const relativeName = entryName.replaceAll("\\", "/");
        if (!relativeName || relativeName.endsWith("/")) {
            continue;
        }

        const target = resolve(destRoot, relativeName);
        if (!isInside(destRoot, target) || target === destRoot) {
            throw new Error(`安装包包含不安全的文件路径，已停止解压：${entryName}`);
        }

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
    }
}

function unzipEntries(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
    return new Promise((resolveEntries, reject) => {
        unzip(bytes, (error, data) => {
            if (error || !data) {
                reject(error ?? new Error("安装包解压失败；请重新下载安装"));
                return;
            }
            resolveEntries(data);
        });
    });
}

function isInside(root: string, candidate: string): boolean {
    const relationship = relative(root, candidate);
    return (
        relationship === "" ||
        (!isAbsolute(relationship) &&
            relationship !== ".." &&
            !relationship.startsWith(`..${sep}`))
    );
}
