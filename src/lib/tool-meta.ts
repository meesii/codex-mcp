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

export const destructiveAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
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
