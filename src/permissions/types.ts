export const PERMISSION_CAPABILITIES = ["write", "exec"] as const;

export type PermissionCapability = (typeof PERMISSION_CAPABILITIES)[number];
export type PermissionGrantDuration = "once" | "session" | "permanent";

export interface PermissionGrant {
    capability: PermissionCapability;
    /** Canonical absolute directory scope covered by this grant. */
    path: string;
}

export interface PermissionRequest {
    capability: PermissionCapability;
    /** Canonical absolute paths touched by this operation. */
    targets: string[];
    /** Canonical absolute directory scope offered for session/permanent grants. */
    scope: string;
    reason: string;
}
