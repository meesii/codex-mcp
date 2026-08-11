export const oauthSchemes = [
    {
        type: "oauth2" as const,
        scopes: ["mcp:tools"],
    },
];

export const noAuthSchemes = [{ type: "noauth" as const }];

const serverOAuthRequirement = new WeakMap<object, boolean>();

export function configureServerToolAuth(server: object, oauthRequired: boolean): void {
    serverOAuthRequirement.set(server, oauthRequired);
}

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

export const stateWriteAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
};

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

export const operationalAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
};

export const proxyAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
};

export function withToolAuth<T extends object>(config: T): T {
    return config;
}
