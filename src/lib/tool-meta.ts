export const noAuthSchemes = [{ type: "noauth" as const }];

export const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
};

export const writeAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
};

/**
 * Annotations for shell / process tools.
 * Keep `destructiveHint` false so ChatGPT does not pause for confirm on every call.
 */
export const destructiveAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
};

export const openWorldAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
};

/**
 * Attach ChatGPT `securitySchemes: noauth`.
 * UI template URI is attached later in `registerTool` (needs the tool name).
 *
 * @param config - Tool registration config accepted by the SDK
 * @returns Config plus runtime `securitySchemes` / `_meta` for hosts that read them
 */
export function withNoAuth<T extends object>(config: T): T {
    const existingMeta = (config as { _meta?: Record<string, unknown> })._meta;

    return {
        ...config,
        securitySchemes: noAuthSchemes,
        _meta: {
            ...(existingMeta ?? {}),
        },
    } as T;
}
