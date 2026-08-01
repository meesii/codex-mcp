import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildServerInstructions } from "../src/mcp-server.js";
import { TOOL_CARD_ENABLED, TOOL_CARD_URI, SUMMARY_CARD_URI } from "../src/ui/constants.js";
import { CORE_TOOL_NAMES } from "../src/tools/names.js";
import { connectMcpClient, toolText } from "./helpers/mcp-client.js";
import { startTestServer } from "./helpers/start-server.js";

/**
 * Assert that a tool result is marked as an error.
 *
 * @param result - Tool call result
 * @param label - Assertion label
 */
function assertToolError(
    result: { isError?: boolean },
    label: string,
): void {
    assert.equal(result.isError, true, `${label}: expected isError`);
}

async function main(): Promise<void> {
    const ctx = await startTestServer();
    const mcp = await connectMcpClient(ctx.mcpUrl);

    let localFetchClose: (() => Promise<void>) | undefined;

    try {
        const toolNames = await mcp.listToolNames();
        assert.deepEqual(
            toolNames,
            [...CORE_TOOL_NAMES].sort(),
            "listTools should expose core coding tools (no gateway without mcp.json)",
        );

        const instructions = buildServerInstructions(ctx.fixtureRoot);
        assert.ok(
            instructions.includes(`<project_root>${ctx.fixtureRoot}</project_root>`),
            "initialize instructions should include the bound project root",
        );
        assert.ok(
            instructions.indexOf(ctx.fixtureRoot) < 512,
            "project root should appear in the first 512 chars of instructions",
        );
        assert.match(instructions, /<shell>(powershell|bash)<\/shell>/);
        assert.match(instructions, /Tool map/i);
        assert.doesNotMatch(instructions, /You are /i);
        assert.match(instructions, /summary\(done=false/i);
        assert.match(instructions, /~6 inspect|6 inspect/i);
        assert.doesNotMatch(instructions, /mcp_tools/i);
        assert.doesNotMatch(instructions, /Downstream MCP servers/);

        const listedTools = await mcp.client.listTools();
        const readTool = listedTools.tools.find((tool) => tool.name === "read");
        assert.ok(readTool);
        const readMeta = readTool._meta as
            | {
                  ui?: { resourceUri?: string };
                  "openai/outputTemplate"?: string;
                  "openai/toolInvocation/invoking"?: string;
                  "openai/toolInvocation/invoked"?: string;
              }
            | undefined;
        assert.equal(readMeta?.["openai/toolInvocation/invoking"], "正在读取文件…");
        assert.equal(readMeta?.["openai/toolInvocation/invoked"], "文件读取完成");

        if (TOOL_CARD_ENABLED) {
            const resources = await mcp.client.listResources();
            const toolCard = resources.resources.find(
                (resource) => resource.uri === TOOL_CARD_URI,
            );
            assert.ok(toolCard, "shared tool card UI resource should be registered");
            assert.equal(readMeta?.ui?.resourceUri, TOOL_CARD_URI);
            assert.equal(readMeta?.["openai/outputTemplate"], TOOL_CARD_URI);

            const cardContents = await mcp.client.readResource({ uri: TOOL_CARD_URI });
            assert.ok(cardContents.contents[0]?.text);

            const summaryTool = listedTools.tools.find((tool) => tool.name === "summary");
            assert.ok(summaryTool);
            const summaryMeta = summaryTool._meta as
                | {
                      ui?: { resourceUri?: string };
                      "openai/outputTemplate"?: string;
                  }
                | undefined;
            assert.equal(summaryMeta?.ui?.resourceUri, SUMMARY_CARD_URI);
            assert.equal(summaryMeta?.["openai/outputTemplate"], SUMMARY_CARD_URI);
            const summaryCard = await mcp.client.readResource({ uri: SUMMARY_CARD_URI });
            assert.ok(summaryCard.contents[0]?.text);
            assert.match(String(summaryCard.contents[0]?.text), /进度汇报/);

            const legacyUri = "ui://codex-mcp/tool-card/write_stdin@v7.html";
            const legacyContents = await mcp.client.readResource({ uri: legacyUri });
            assert.equal(legacyContents.contents[0]?.uri, legacyUri);
        } else {
            assert.equal(readMeta?.ui?.resourceUri, undefined);
            assert.equal(readMeta?.["openai/outputTemplate"], undefined);
        }

        // read success
        const readOk = await mcp.callTool("read", {
            path: "hello.txt",
        });
        assert.notEqual(readOk.isError, true, toolText(readOk));
        assert.match(toolText(readOk), /Read hello\.txt/);
        const readStructured = readOk.structuredContent as { content?: string };
        assert.match(readStructured.content ?? "", /hello world/);

        const readUiCard = (readOk._meta as { uiCard?: {
            tool?: string;
            label?: string;
            ok?: boolean;
            title?: string;
            outcome?: string;
            args?: Record<string, string | number | boolean>;
            params?: Array<{ label: string; value: string }>;
        } } | undefined)?.uiCard;
        assert.ok(readUiCard, "read result should include _meta.uiCard");
        assert.equal(readUiCard.tool, "read");
        assert.equal(readUiCard.label, "读取文件");
        assert.equal(readUiCard.ok, true);
        assert.equal(readUiCard.title, "hello.txt");
        assert.match(readUiCard.outcome ?? "", /行/);
        const pathParam = (readUiCard.params ?? []).find((row) => row.label === "路径");
        assert.equal(pathParam?.value, "hello.txt");
        assert.equal(readUiCard.args?.path, "hello.txt");
        assert.ok(
            !(readUiCard.params ?? []).some((row) => row.label === "content"),
            "UI params must not include file body",
        );

        // read missing
        const readMissing = await mcp.callTool("read", {
            path: "missing.txt",
        });
        assertToolError(readMissing, "read missing");

        // write success + escape failure
        const writeOk = await mcp.callTool("write", {
            path: "notes/out.txt",
            content: "written-by-test\n",
        });
        assert.notEqual(writeOk.isError, true, toolText(writeOk));
        const written = await readFile(join(ctx.fixtureRoot, "notes", "out.txt"), "utf8");
        assert.equal(written, "written-by-test\n");

        const writeEscape = await mcp.callTool("write", {
            path: "../escape.txt",
            content: "nope",
        });
        assertToolError(writeEscape, "write escape");

        // edit success + mismatch
        const editOk = await mcp.callTool("edit", {
            path: "hello.txt",
            old_string: "unique-marker-alpha",
            new_string: "unique-marker-beta",
        });
        assert.notEqual(editOk.isError, true, toolText(editOk));
        const edited = await readFile(join(ctx.fixtureRoot, "hello.txt"), "utf8");
        assert.match(edited, /unique-marker-beta/);

        const editMiss = await mcp.callTool("edit", {
            path: "hello.txt",
            old_string: "does-not-exist-zzz",
            new_string: "x",
        });
        assertToolError(editMiss, "edit mismatch");

        // bash success + non-zero
        const bashOk = await mcp.callTool("bash", {
            command:
                process.platform === "win32"
                    ? "Write-Output 'bash-ok'"
                    : "echo bash-ok",
        });
        assert.notEqual(bashOk.isError, true, toolText(bashOk));
        assert.match(toolText(bashOk), /exit_code=0/);
        const bashStructured = bashOk.structuredContent as { stdout?: string };
        assert.match(bashStructured.stdout ?? "", /bash-ok/);

        const bashFail = await mcp.callTool("bash", {
            command:
                process.platform === "win32"
                    ? "exit 7"
                    : "exit 7",
        });
        assertToolError(bashFail, "bash non-zero");

        // exec_command short (finishes, no processId)
        const execShort = await mcp.callTool("exec_command", {
            command:
                process.platform === "win32"
                    ? "Write-Output 'exec-ok'"
                    : "echo exec-ok",
            yield_time_ms: 5_000,
        });
        assert.notEqual(execShort.isError, true, toolText(execShort));
        const execShortData = execShort.structuredContent as {
            running?: boolean;
            processId?: number;
            output?: string;
        };
        assert.equal(execShortData.running, false);
        assert.equal(execShortData.processId, undefined);
        assert.match(execShortData.output ?? "", /exec-ok/);

        // exec_command long-running → processId → write_stdin poll → process_kill
        const execBg = await mcp.callTool("exec_command", {
            command:
                process.platform === "win32"
                    ? "Start-Sleep -Seconds 60"
                    : "sleep 60",
            yield_time_ms: 400,
        });
        assert.notEqual(execBg.isError, true, toolText(execBg));
        const execBgData = execBg.structuredContent as {
            running?: boolean;
            processId?: number;
        };
        assert.equal(execBgData.running, true, toolText(execBg));
        assert.ok(
            typeof execBgData.processId === "number" && execBgData.processId > 0,
            `expected processId, got ${String(execBgData.processId)}`,
        );
        const processId = execBgData.processId;

        const poll = await mcp.callTool("write_stdin", {
            processId,
            yield_time_ms: 200,
        });
        assert.notEqual(poll.isError, true, toolText(poll));
        assert.equal(
            (poll.structuredContent as { running?: boolean }).running,
            true,
            toolText(poll),
        );

        const killed = await mcp.callTool("process_kill", {
            processId,
        });
        assert.notEqual(killed.isError, true, toolText(killed));
        assert.equal(
            (killed.structuredContent as { running?: boolean }).running,
            false,
            toolText(killed),
        );

        const killMiss = await mcp.callTool("process_kill", {
            processId,
        });
        assertToolError(killMiss, "process_kill unknown id");

        // grep hit + empty
        const grepHit = await mcp.callTool("grep", {
            pattern: "unique-marker-beta",
        });
        assert.notEqual(grepHit.isError, true, toolText(grepHit));
        const grepHitStructured = grepHit.structuredContent as { matches?: string[] };
        assert.ok(
            (grepHitStructured.matches ?? []).some((line) => line.includes("unique-marker-beta")),
        );

        const grepEmpty = await mcp.callTool("grep", {
            pattern: "no-such-pattern-qqq-123",
        });
        assert.notEqual(grepEmpty.isError, true, toolText(grepEmpty));
        assert.equal((grepEmpty.structuredContent as { matchCount?: number }).matchCount, 0);

        // glob hit + empty
        const globHit = await mcp.callTool("glob", {
            pattern: "**/*.txt",
        });
        assert.notEqual(globHit.isError, true, toolText(globHit));
        const globFiles = (globHit.structuredContent as { files?: string[] }).files ?? [];
        assert.ok(
            globFiles.some((file) => file.replaceAll("\\", "/").endsWith("hello.txt")),
            `glob **/*.txt should include hello.txt, got: ${JSON.stringify(globFiles)}`,
        );

        const globEmpty = await mcp.callTool("glob", {
            pattern: "**/*.nope-extension",
        });
        assert.notEqual(globEmpty.isError, true, toolText(globEmpty));
        assert.equal((globEmpty.structuredContent as { count?: number }).count, 0);

        // ls success + not a directory
        const lsOk = await mcp.callTool("ls", {
            path: ".",
        });
        assert.notEqual(lsOk.isError, true, toolText(lsOk));
        const lsEntries =
            (lsOk.structuredContent as { entries?: Array<{ name: string }> }).entries ?? [];
        assert.ok(lsEntries.some((entry) => entry.name === "hello.txt"));

        const lsFile = await mcp.callTool("ls", {
            path: "hello.txt",
        });
        assertToolError(lsFile, "ls file");

        // webfetch local server
        const pageHtml =
            "<html><body><h1>FetchFixture</h1><p>hello-fetch</p></body></html>";
        const local = createServer((req, res) => {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(pageHtml);
        });
        await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", () => resolve()));
        const address = local.address();
        assert.ok(address && typeof address === "object");
        const fetchUrl = `http://127.0.0.1:${address.port}/doc`;
        localFetchClose = () =>
            new Promise<void>((resolve, reject) => {
                local.close((error) => (error ? reject(error) : resolve()));
            });

        const fetchOk = await mcp.callTool("webfetch", {
            url: fetchUrl,
            format: "markdown",
        });
        assert.notEqual(fetchOk.isError, true, toolText(fetchOk));
        const fetchBody = (fetchOk.structuredContent as { body?: string }).body ?? "";
        assert.match(fetchBody, /FetchFixture|hello-fetch/);

        const fetchBad = await mcp.callTool("webfetch", {
            url: "file:///etc/passwd",
        });
        assertToolError(fetchBad, "webfetch non-http");

        // summary checkpoint (keeps the tool loop alive)
        const summaryContinue = await mcp.callTool("summary", {
            summary: "Listed project files",
            next: "Read hello.txt",
            done: false,
        });
        assert.notEqual(summaryContinue.isError, true, toolText(summaryContinue));
        assert.match(toolText(summaryContinue), /done=false/);
        assert.match(toolText(summaryContinue), /Codex-MCP/);
        assert.match(toolText(summaryContinue), /Read hello\.txt/);
        const summaryContinueData = summaryContinue.structuredContent as {
            done?: boolean;
            continueWorking?: boolean;
            next?: string | null;
        };
        assert.equal(summaryContinueData.done, false);
        assert.equal(summaryContinueData.continueWorking, true);
        assert.equal(summaryContinueData.next, "Read hello.txt");
        const summaryContinueCard = (summaryContinue._meta as {
            uiCard?: {
                done?: boolean;
                summaryText?: string;
                nextText?: string | null;
                label?: string;
            };
        })?.uiCard;
        assert.ok(summaryContinueCard);
        assert.equal(summaryContinueCard.done, false);
        assert.equal(summaryContinueCard.label, "进度汇报");
        assert.match(summaryContinueCard.summaryText ?? "", /Listed project files/);
        assert.equal(summaryContinueCard.nextText, "Read hello.txt");

        const summaryDone = await mcp.callTool("summary", {
            summary: "All requested work finished",
            done: true,
        });
        assert.notEqual(summaryDone.isError, true, toolText(summaryDone));
        assert.match(toolText(summaryDone), /done=true/i);
        const summaryDoneData = summaryDone.structuredContent as {
            done?: boolean;
            continueWorking?: boolean;
        };
        assert.equal(summaryDoneData.done, true);
        assert.equal(summaryDoneData.continueWorking, false);
        const summaryDoneCard = (summaryDone._meta as {
            uiCard?: { done?: boolean; label?: string; nextText?: string | null };
        })?.uiCard;
        assert.ok(summaryDoneCard);
        assert.equal(summaryDoneCard.done, true);
        assert.equal(summaryDoneCard.label, "任务完成");
        assert.equal(summaryDoneCard.nextText, null);

        console.log("All MCP client e2e tool tests passed.");
    } finally {
        await mcp.close().catch(() => undefined);
        if (localFetchClose) await localFetchClose().catch(() => undefined);
        await ctx.server.close().catch(() => undefined);
    }
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
