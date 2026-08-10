export const oauthSchemes = [
    {
        type: "oauth2" as const,
        scopes: ["mcp:tools"],
    },
];

export const noAuthSchemes = [{ type: "noauth" as const }];

const serverOAuthRequirement = new WeakMap<object, boolean>();

/** Associate one MCP server instance with its HTTP authorization mode. */
export function configureServerToolAuth(server: object, oauthRequired: boolean): void {
    serverOAuthRequirement.set(server, oauthRequired);
}

/** Resolve tool security metadata for the concrete server instance. */
export function securitySchemesForServer(server: object) {
    return serverOAuthRequirement.get(server) === false ? noAuthSchemes : oauthSchemes;
}

export const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
};

export const writeAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
};

/** Shell/process interactions can mutate local state and reach external systems. */
export const destructiveAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
};

export const openWorldAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
};

/** Connection/config lifecycle operations can spawn/reconnect but do not edit user data. */
export const operationalAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
};

/** Downstream proxy calls may mutate external systems. */
export const proxyAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
};

/**
 * Keep tool definitions uniform at call sites. The concrete security scheme is
 * injected centrally by registerTool(), because local and public server
 * instances can coexist in the same process with different auth requirements.
 */
export function withToolAuth<T extends object>(config: T): T {
    return config;
}
