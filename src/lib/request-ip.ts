import type { Request } from "express";

/**
 * Return a rate-limit key for a request without trusting arbitrary forwarding
 * headers. Cloudflare Tunnel reaches the local listener from loopback and
 * supplies/overwrites CF-Connecting-IP, so that header is trusted only when the
 * direct socket peer is loopback.
 */
export function requestClientKey(req: Request): string {
    const peer = normalizeIp(req.socket.remoteAddress ?? "");
    if (isLoopback(peer)) {
        const cloudflareIp = req.header("cf-connecting-ip")?.trim();
        if (cloudflareIp) return `cf:${cloudflareIp}`;
    }
    return `peer:${peer || "unknown"}`;
}

function normalizeIp(address: string): string {
    if (address.startsWith("::ffff:")) return address.slice("::ffff:".length);
    return address;
}

function isLoopback(address: string): boolean {
    return address === "127.0.0.1" || address === "::1";
}
