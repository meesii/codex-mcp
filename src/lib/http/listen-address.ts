/** A local control URL must use a reachable loopback address, never a wildcard. */
export function loopbackHost(listenHost: string): string {
    return listenHost === "::" || listenHost === "::1" ? "[::1]" : "127.0.0.1";
}
