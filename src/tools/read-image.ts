import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult } from "../lib/tool/result.js";
import { projectErrorResult, type ToolScopeProvider } from "../server/project-router.js";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 50 * 1_000_000;
const PASSTHROUGH_BYTES = 1 * 1024 * 1024;
const TARGET_BYTES = 1536 * 1024;
const MAX_OUTPUT_BYTES = 3 * 1024 * 1024;

export function registerReadImageTool(server: McpServer, scope: ToolScopeProvider): void {
    registerTool(server, "read_image", withToolAuth({
        title: "Read image",
        description: "Read an image as MCP image content. By default, large images are resized and JPEG-compressed before returning. Supports PNG, JPEG, GIF, and WebP.",
        inputSchema: {
            path: z.string().min(1),
            process: z.enum(["auto", "none"]).optional(),
            max_long_edge: z.number().int().min(256).max(4096).optional(),
            quality: z.number().int().min(40).max(95).optional(),
        },
        outputSchema: {
            path: z.string(), mimeType: z.string(), size: z.number().int(), originalSize: z.number().int(),
            originalWidth: z.number().int(), originalHeight: z.number().int(), width: z.number().int(),
            height: z.number().int(), processed: z.boolean(), quality: z.number().int().optional(),
        },
        annotations: readOnlyAnnotations,
    }), async ({ path, process, max_long_edge: maxLongEdgeInput, quality: qualityInput }) => {
        try {
            const { project } = scope();
            const absolute = project.resolvePath(path);
            const info = await stat(absolute).catch(() => null);
            if (!info?.isFile()) return errorResult(`File not found: ${path}`);
            if (info.size > MAX_SOURCE_BYTES) return errorResult(`Image too large: ${info.size} bytes; maximum is ${MAX_SOURCE_BYTES}.`);

            const mimeType = imageMimeType(path);
            if (!mimeType) return errorResult(`Unsupported image format: ${path}. Supported: PNG, JPEG, GIF, WebP.`);
            const original = await readFile(absolute);
            const metadata = await sharp(original, { animated: false }).metadata();
            const originalWidth = metadata.width ?? 0;
            const originalHeight = metadata.height ?? 0;
            if (!originalWidth || !originalHeight) return errorResult(`Failed to decode image: ${path}`);
            if (originalWidth * originalHeight > MAX_SOURCE_PIXELS) {
                return errorResult(`Image dimensions are too large: ${originalWidth}x${originalHeight}.`);
            }

            const mode = process ?? "auto";
            const maxLongEdge = maxLongEdgeInput ?? 2048;
            const requestedQuality = qualityInput ?? 82;
            const originalLongEdge = Math.max(originalWidth, originalHeight);
            if (mode === "none") {
                if (original.length > MAX_OUTPUT_BYTES) return errorResult(`Unprocessed image is too large to return; use process=auto.`);
                return imageResult(path, original, mimeType, original.length, originalWidth, originalHeight, false);
            }
            if (original.length <= PASSTHROUGH_BYTES && originalLongEdge <= maxLongEdge) {
                return imageResult(path, original, mimeType, original.length, originalWidth, originalHeight, false);
            }

            let longEdge = Math.min(originalLongEdge, maxLongEdge);
            let outputQuality = requestedQuality;
            let output = await encodeJpeg(original, longEdge, outputQuality);
            for (const candidate of [75, 68, 60]) {
                if (output.length <= TARGET_BYTES || candidate >= outputQuality) continue;
                outputQuality = candidate;
                output = await encodeJpeg(original, longEdge, outputQuality);
            }
            while (output.length > TARGET_BYTES && longEdge > 640) {
                longEdge = Math.max(640, Math.round(longEdge * 0.85));
                output = await encodeJpeg(original, longEdge, outputQuality);
            }
            if (output.length > MAX_OUTPUT_BYTES) return errorResult(`Processed image is still too large: ${output.length} bytes.`);
            const outputMeta = await sharp(output).metadata();
            return imageResult(path, output, "image/jpeg", original.length, originalWidth, originalHeight, true, outputMeta.width, outputMeta.height, outputQuality);
        } catch (error) {
            return projectErrorResult(error);
        }
    });
}

async function encodeJpeg(input: Buffer, longEdge: number, quality: number): Promise<Buffer> {
    return await sharp(input, { animated: false })
        .rotate()
        .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
}

function imageResult(
    path: string, bytes: Buffer, mimeType: string, originalSize: number,
    originalWidth: number, originalHeight: number, processed: boolean,
    width = originalWidth, height = originalHeight, quality?: number,
) {
    return {
        content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType }],
        structuredContent: { path, mimeType, size: bytes.length, originalSize, originalWidth, originalHeight, width, height, processed, ...(quality === undefined ? {} : { quality }) },
    };
}

function imageMimeType(path: string): string | undefined {
    switch (extname(path).toLowerCase()) {
        case ".png": return "image/png";
        case ".jpg": case ".jpeg": return "image/jpeg";
        case ".gif": return "image/gif";
        case ".webp": return "image/webp";
        default: return undefined;
    }
}
