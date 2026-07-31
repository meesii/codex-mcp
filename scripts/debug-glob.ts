import { startTestServer } from "../test/helpers/start-server.js";
import { connectMcpClient } from "../test/helpers/mcp-client.js";
import { findRipgrep, runRipgrep } from "../src/lib/ripgrep.js";

async function main(): Promise<void> {
    const ctx = await startTestServer();
    const rg = await findRipgrep();
    console.log("rg=", rg);
    if (rg) {
        const nested = await runRipgrep(rg, ["--files", "-g", "**/*.txt"], ctx.fixtureRoot);
        console.log("rg **/*.txt", {
            code: nested.exitCode,
            stdout: nested.stdout,
            stderr: nested.stderr,
        });
        const flat = await runRipgrep(rg, ["--files", "-g", "*.txt"], ctx.fixtureRoot);
        console.log("rg *.txt", {
            code: flat.exitCode,
            stdout: flat.stdout,
            stderr: flat.stderr,
        });
    }

    const mcp = await connectMcpClient(ctx.mcpUrl);
    const globHit = await mcp.callTool("glob", { pattern: "**/*.txt" });
    console.log("glob tool", JSON.stringify(globHit, null, 2));
    await mcp.close();
    await ctx.server.close();
}

void main();
