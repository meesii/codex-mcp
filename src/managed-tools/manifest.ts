import type { ManagedToolName } from "./paths.js";

export type ManagedArchive = "raw" | "tar.gz" | "zip";

export interface ManagedToolSpec {
    tool: ManagedToolName;
    label: string;
    version: string;
    url: string;
    sha256: string;
    archive: ManagedArchive;
    archiveEntry?: string;
}

const RIPGREP_VERSION = "15.2.0";
const CLOUDFLARED_VERSION = "2026.7.2";

const RIPGREP_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}`;
const CLOUDFLARED_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

function ripgrepSpec(target: string, sha256: string, archive: ManagedArchive): ManagedToolSpec {
    const fileName = `ripgrep-${RIPGREP_VERSION}-${target}.${archive === "zip" ? "zip" : "tar.gz"}`;
    const root = fileName.replace(/\.(?:zip|tar\.gz)$/, "");
    return {
        tool: "ripgrep",
        label: "文件搜索组件",
        version: RIPGREP_VERSION,
        url: `${RIPGREP_BASE}/${fileName}`,
        sha256,
        archive,
        archiveEntry: `${root}/${target.includes("windows") ? "rg.exe" : "rg"}`,
    };
}

function cloudflaredSpec(fileName: string, sha256: string, archive: ManagedArchive): ManagedToolSpec {
    return {
        tool: "cloudflared",
        label: "公网连接组件",
        version: CLOUDFLARED_VERSION,
        url: `${CLOUDFLARED_BASE}/${fileName}`,
        sha256,
        archive,
        archiveEntry: archive === "tar.gz" ? "cloudflared" : undefined,
    };
}

export function getManagedToolSpec(
    tool: ManagedToolName,
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): ManagedToolSpec {
    if (tool === "ripgrep") {
        if (platform === "darwin" && arch === "arm64") {
            return ripgrepSpec("aarch64-apple-darwin", "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4", "tar.gz");
        }
        if (platform === "darwin" && arch === "x64") {
            return ripgrepSpec("x86_64-apple-darwin", "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1", "tar.gz");
        }
        if (platform === "linux" && arch === "arm64") {
            return ripgrepSpec("aarch64-unknown-linux-musl", "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915", "tar.gz");
        }
        if (platform === "linux" && arch === "x64") {
            return ripgrepSpec("x86_64-unknown-linux-musl", "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c", "tar.gz");
        }
        if (platform === "win32" && arch === "arm64") {
            return ripgrepSpec("aarch64-pc-windows-msvc", "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f", "zip");
        }
        if (platform === "win32" && arch === "x64") {
            return ripgrepSpec("x86_64-pc-windows-msvc", "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5", "zip");
        }
    }

    if (tool === "cloudflared") {
        if (platform === "darwin" && arch === "arm64") {
            return cloudflaredSpec("cloudflared-darwin-arm64.tgz", "2086e51c61d6565781d84117a5007d0c826d03ffdc74acb91c08c167f9f8cd7c", "tar.gz");
        }
        if (platform === "darwin" && arch === "x64") {
            return cloudflaredSpec("cloudflared-darwin-amd64.tgz", "4ee0d3b48a990a2f9b5faec5838f73ec1f400aa8e0a4864be576adfafec406cb", "tar.gz");
        }
        if (platform === "linux" && arch === "arm64") {
            return cloudflaredSpec("cloudflared-linux-arm64", "405df476437e027fc6d18729a5a77155c0a33a6082aeee60a799a688f3052e66", "raw");
        }
        if (platform === "linux" && arch === "x64") {
            return cloudflaredSpec("cloudflared-linux-amd64", "ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd", "raw");
        }
        if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
            // Cloudflare does not publish a Windows ARM64 binary. Windows 11 ARM can run the x64 build.
            return cloudflaredSpec("cloudflared-windows-amd64.exe", "cdb5d4432f6ae1595654a692a51308b69d2bf7af961f5578d9391837cf072df9", "raw");
        }
    }

    throw new Error(`暂不支持这个系统组合：${platform}/${arch}`);
}
