import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServerInstructions } from "../src/mcp-server.js";
import { PACKAGE_VERSION } from "../src/version.js";
import { TOOL_CARD_ENABLED, TOOL_CARD_URI, SUMMARY_CARD_URI } from "../src/ui/constants.js";
import { listGlobFiles } from "../src/tools/glob.js";
import { TOOL_NAMES } from "../src/tools/names.js";
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

    try {
        const toolNames = await mcp.listToolNames();
        assert.deepEqual(
            toolNames,
            [...TOOL_NAMES].sort(),
            "listTools should expose the fixed tool surface so hot-loaded capabilities work in existing sessions",
        );

        // Public HTTP serving is deliberately stateless. A stale session id from a
        // proxy/client reconnect must never poison subsequent tool requests.
        const staleSessionResponse = await fetch(ctx.mcpUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                "Mcp-Protocol-Version": "2025-11-25",
                "Mcp-Session-Id": "stale-session-regression",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: "stale-session",
                method: "tools/list",
                params: {},
            }),
        });
        assert.equal(staleSessionResponse.status, 200);
        assert.equal(staleSessionResponse.headers.get("mcp-session-id"), null);
        assert.match(await staleSessionResponse.text(), /"tools"/);

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
        assert.doesNotMatch(instructions, /~6 inspect|6 inspect/i);
        assert.match(instructions, /do not re-load agents_for_path unless moving deeper/i);
        assert.match(instructions, /skills_list/);
        assert.match(instructions, /skill_read/);
        assert.match(instructions, /mcp_tools/i);
        assert.doesNotMatch(instructions, /Downstream MCP servers/);

        const serverInfo = await mcp.callTool("server_info", {});
        assert.notEqual(serverInfo.isError, true, toolText(serverInfo));
        const serverInfoData = serverInfo.structuredContent as {
            version?: string;
            projectRoot?: string;
            toolsetHash?: string;
            restartRequiredForCoreToolChanges?: boolean;
            capabilities?: { structuredSearch?: boolean; mutationDiff?: boolean };
        };
        assert.equal(serverInfoData.version, PACKAGE_VERSION);
        assert.equal(serverInfoData.projectRoot, ctx.server.project.root);
        assert.match(serverInfoData.toolsetHash ?? "", /^[a-f0-9]{16}$/);
        assert.equal(serverInfoData.restartRequiredForCoreToolChanges, true);
        assert.equal(serverInfoData.capabilities?.structuredSearch, true);
        assert.equal(serverInfoData.capabilities?.mutationDiff, true);

        const emptySkills = await mcp.callTool("skills_list", {});
        assert.notEqual(emptySkills.isError, true, toolText(emptySkills));
        assert.equal((emptySkills.structuredContent as { count?: number }).count, 0);
        const missingSkill = await mcp.callTool("skill_read", { name: "missing" });
        assertToolError(missingSkill, "skill_read missing");

        const listedTools = await mcp.client.listTools();
        const readTool = listedTools.tools.find((tool) => tool.name === "read");
        assert.ok(readTool);
        const readMeta = readTool._meta as
            | {
                  ui?: { resourceUri?: string };
                  "openai/outputTemplate"?: string;
                  "openai/toolInvocation/invoking"?: string;
                  "openai/toolInvocation/invoked"?: string;
                  securitySchemes?: Array<{ type?: string; scopes?: string[] }>;
              }
            | undefined;
        assert.equal(readMeta?.["openai/toolInvocation/invoking"], "正在读取文件…");
        assert.equal(readMeta?.["openai/toolInvocation/invoked"], "文件读取完成");
        assert.equal(readMeta?.securitySchemes?.[0]?.type, "noauth");
        const writeToolDescriptor = listedTools.tools.find((tool) => tool.name === "write");
        const bashToolDescriptor = listedTools.tools.find((tool) => tool.name === "bash");
        const writeStdinToolDescriptor = listedTools.tools.find(
            (tool) => tool.name === "write_stdin",
        );
        const processKillToolDescriptor = listedTools.tools.find(
            (tool) => tool.name === "process_kill",
        );
        const runtimeStatusToolDescriptor = listedTools.tools.find(
            (tool) => tool.name === "runtime_status",
        );
        assert.equal(writeToolDescriptor?.annotations?.destructiveHint, true);
        assert.equal(bashToolDescriptor?.annotations?.destructiveHint, true);
        assert.equal(bashToolDescriptor?.annotations?.openWorldHint, true);
        assert.match(
            writeStdinToolDescriptor?.description ?? "",
            /Windows.*force-stops the process tree/i,
        );
        assert.equal(processKillToolDescriptor?.annotations?.destructiveHint, true);
        assert.equal(processKillToolDescriptor?.annotations?.openWorldHint, false);
        assert.equal(runtimeStatusToolDescriptor?.annotations?.readOnlyHint, true);
        assert.equal(runtimeStatusToolDescriptor?.annotations?.openWorldHint, false);

        if (TOOL_CARD_ENABLED) {
            const resources = await mcp.client.listResources();
            const toolCard = resources.resources.find(
                (resource) => resource.uri === TOOL_CARD_URI,
            );
            assert.ok(toolCard, "shared tool card UI resource should be registered");
            assert.equal(readMeta?.ui?.resourceUri, TOOL_CARD_URI);
            assert.equal(readMeta?.["openai/outputTemplate"], TOOL_CARD_URI);

            const cardContents = await mcp.client.readResource({ uri: TOOL_CARD_URI });
            const cardContent = cardContents.contents[0];
            assert.ok(cardContent && "text" in cardContent);
            const cardHtml = cardContent.text;
            assert.doesNotMatch(cardHtml, /setInterval\(readHost,\s*250\)/);
            assert.match(cardHtml, /pollAttempts\s*>=\s*40/);

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
            const summaryContent = summaryCard.contents[0];
            assert.ok(summaryContent && "text" in summaryContent);
            assert.match(summaryContent.text, /进度汇报/);

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

        const readMany = await mcp.callTool("read_many", {
            files: [{ path: "hello.txt", limit: 1 }, { path: "missing.txt" }],
        });
        assert.notEqual(readMany.isError, true, toolText(readMany));
        const readManyRows = (readMany.structuredContent as {
            files?: Array<{ path: string; content: string; error: string | null }>;
        }).files ?? [];
        assert.match(readManyRows.find((item) => item.path === "hello.txt")?.content ?? "", /hello world/);
        assert.match(readManyRows.find((item) => item.path === "missing.txt")?.error ?? "", /ENOENT/i);

        await writeFile(
            join(ctx.fixtureRoot, "large.txt"),
            `${"x".repeat(120_000)}\nsecond-line\n`,
            "utf8",
        );
        const largeRead = await mcp.callTool("read", { path: "large.txt" });
        assert.notEqual(largeRead.isError, true, toolText(largeRead));
        const largeReadData = largeRead.structuredContent as {
            content?: string;
            truncated?: boolean;
        };
        assert.equal(largeReadData.truncated, true);
        assert.ok((largeReadData.content ?? "").length < 81_000);

        // write success + escape failure
        const writeOk = await mcp.callTool("write", {
            path: "notes/out.txt",
            content: "written-by-test\n",
        });
        assert.notEqual(writeOk.isError, true, toolText(writeOk));
        const writeData = writeOk.structuredContent as {
            filesChanged?: number;
            diff?: string;
            diffTruncated?: boolean;
        };
        assert.equal(writeData.filesChanged, 1);
        assert.match(writeData.diff ?? "", /\+written-by-test/);
        assert.equal(writeData.diffTruncated, false);
        const written = await readFile(join(ctx.fixtureRoot, "notes", "out.txt"), "utf8");
        assert.equal(written, "written-by-test\n");

        const writeEscape = await mcp.callTool("write", {
            path: "../escape.txt",
            content: "nope",
        });
        assertToolError(writeEscape, "write escape");

        // symlink/junction must not escape the canonical project root
        const outsideRoot = await mkdtemp(join(tmpdir(), "codex-mcp-outside-"));
        await writeFile(join(outsideRoot, "secret.txt"), "outside-secret\n", "utf8");
        await symlink(
            outsideRoot,
            join(ctx.fixtureRoot, "outside-link"),
            process.platform === "win32" ? "junction" : "dir",
        );
        assertToolError(
            await mcp.callTool("read", { path: "outside-link/secret.txt" }),
            "read symlink escape",
        );
        assertToolError(
            await mcp.callTool("write", {
                path: "outside-link/new.txt",
                content: "must-not-write",
            }),
            "write symlink escape",
        );
        assertToolError(
            await mcp.callTool("edit", {
                path: "outside-link/secret.txt",
                old_string: "outside-secret",
                new_string: "changed",
            }),
            "edit symlink escape",
        );
        assertToolError(
            await mcp.callTool("apply_patch", {
                patch: [
                    "--- a/outside-link/secret.txt",
                    "+++ b/outside-link/secret.txt",
                    "@@ -1,1 +1,1 @@",
                    "-outside-secret",
                    "+changed",
                    "",
                ].join("\n"),
            }),
            "apply_patch symlink escape",
        );
        assertToolError(
            await mcp.callTool("ls", { path: "outside-link" }),
            "ls symlink escape",
        );
        await assert.rejects(readFile(join(outsideRoot, "new.txt"), "utf8"), /ENOENT/);
        assert.equal(await readFile(join(outsideRoot, "secret.txt"), "utf8"), "outside-secret\n");

        if (process.platform !== "win32") {
            const danglingTarget = join(outsideRoot, "created-through-dangling-link.txt");
            await symlink(danglingTarget, join(ctx.fixtureRoot, "dangling-link"), "file");
            assertToolError(
                await mcp.callTool("write", {
                    path: "dangling-link",
                    content: "must-not-create",
                }),
                "write dangling symlink escape",
            );
            await assert.rejects(readFile(danglingTarget, "utf8"), /ENOENT/);
        }

        // edit success + mismatch
        const editOk = await mcp.callTool("edit", {
            path: "hello.txt",
            old_string: "unique-marker-alpha",
            new_string: "unique-marker-beta",
        });
        assert.notEqual(editOk.isError, true, toolText(editOk));
        const editData = editOk.structuredContent as {
            filesChanged?: number;
            diff?: string;
            diffTruncated?: boolean;
        };
        assert.equal(editData.filesChanged, 1);
        assert.match(editData.diff ?? "", /-.*unique-marker-alpha/);
        assert.match(editData.diff ?? "", /\+.*unique-marker-beta/);
        assert.equal(editData.diffTruncated, false);
        const edited = await readFile(join(ctx.fixtureRoot, "hello.txt"), "utf8");
        assert.match(edited, /unique-marker-beta/);

        const editMiss = await mcp.callTool("edit", {
            path: "hello.txt",
            old_string: "does-not-exist-zzz",
            new_string: "x",
        });
        assertToolError(editMiss, "edit mismatch");

        await writeFile(join(ctx.fixtureRoot, "literal.txt"), "OLD\n", "utf8");
        const literalEdit = await mcp.callTool("edit", {
            path: "literal.txt",
            old_string: "OLD",
            new_string: "$& $$ $'",
        });
        assert.notEqual(literalEdit.isError, true, toolText(literalEdit));
        assert.equal(await readFile(join(ctx.fixtureRoot, "literal.txt"), "utf8"), "$& $$ $'\n");
        const emptyEdit = await mcp.callTool("edit", {
            path: "literal.txt",
            old_string: "",
            new_string: "x",
        });
        assertToolError(emptyEdit, "edit empty old_string");

        await writeFile(join(ctx.fixtureRoot, "crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n", "utf8");
        const crlfRead = await mcp.callTool("read", { path: "crlf.txt", limit: 2 });
        assert.notEqual(crlfRead.isError, true, toolText(crlfRead));
        const crlfContent = (crlfRead.structuredContent as { content?: string }).content ?? "";
        assert.equal(crlfContent, "alpha\r\nbeta\r\n");
        const crlfEdit = await mcp.callTool("edit", {
            path: "crlf.txt",
            old_string: crlfContent,
            new_string: "alpha2\r\nbeta2\r\n",
        });
        assert.notEqual(crlfEdit.isError, true, toolText(crlfEdit));
        assert.equal(
            await readFile(join(ctx.fixtureRoot, "crlf.txt"), "utf8"),
            "alpha2\r\nbeta2\r\ngamma\r\n",
        );

        // apply_patch multi-file + preflight failure must not partially modify files
        await writeFile(join(ctx.fixtureRoot, "patch-a.txt"), "one\ntwo\nthree\n", "utf8");
        const patchOk = await mcp.callTool("apply_patch", {
            patch: [
                "--- a/patch-a.txt",
                "+++ b/patch-a.txt",
                "@@ -1,3 +1,3 @@",
                " one",
                "-two",
                "+TWO",
                " three",
                "--- /dev/null",
                "+++ b/patch-new.txt",
                "@@ -0,0 +1,2 @@",
                "+alpha",
                "+beta",
                "",
            ].join("\n"),
        });
        assert.notEqual(patchOk.isError, true, toolText(patchOk));
        assert.equal(await readFile(join(ctx.fixtureRoot, "patch-a.txt"), "utf8"), "one\nTWO\nthree\n");
        assert.equal(await readFile(join(ctx.fixtureRoot, "patch-new.txt"), "utf8"), "alpha\nbeta\n");
        assert.equal((patchOk.structuredContent as { filesChanged?: number }).filesChanged, 2);

        await writeFile(join(ctx.fixtureRoot, "patch-delete.txt"), "gone\n", "utf8");
        const patchDelete = await mcp.callTool("apply_patch", {
            patch: [
                "--- a/patch-delete.txt",
                "+++ /dev/null",
                "@@ -1,1 +0,0 @@",
                "-gone",
                "",
            ].join("\n"),
        });
        assert.notEqual(patchDelete.isError, true, toolText(patchDelete));
        await assert.rejects(readFile(join(ctx.fixtureRoot, "patch-delete.txt"), "utf8"), /ENOENT/);

        const patchBeforeFailure = await readFile(join(ctx.fixtureRoot, "patch-a.txt"), "utf8");
        const patchFail = await mcp.callTool("apply_patch", {
            patch: [
                "--- a/patch-a.txt",
                "+++ b/patch-a.txt",
                "@@ -1,1 +1,1 @@",
                "-one",
                "+ONE",
                "--- a/missing-patch-source.txt",
                "+++ b/missing-patch-source.txt",
                "@@ -1,1 +1,1 @@",
                "-missing",
                "+changed",
                "",
            ].join("\n"),
        });
        assertToolError(patchFail, "apply_patch preflight failure");
        assert.equal(
            await readFile(join(ctx.fixtureRoot, "patch-a.txt"), "utf8"),
            patchBeforeFailure,
            "failed patch must not partially modify earlier files",
        );

        // bash success + non-zero
        const bashOk = await mcp.callTool("bash", {
            command:
                process.platform === "win32"
                    ? "Write-Output 'bash-ok'"
                    : "echo bash-ok",
        });
        assert.notEqual(bashOk.isError, true, toolText(bashOk));
        assert.match(toolText(bashOk), /exit_code=0/);
        const bashStructured = bashOk.structuredContent as { stdout?: string; outputMode?: string };
        assert.match(bashStructured.stdout ?? "", /bash-ok/);
        assert.equal(bashStructured.outputMode, "summary");

        await mkdir(join(ctx.fixtureRoot, "command-cwd"), { recursive: true });
        const bashCwd = await mcp.callTool("bash", {
            command: process.platform === "win32" ? "(Get-Location).Path" : "pwd",
            cwd: "command-cwd",
            output_mode: "tail",
        });
        assert.notEqual(bashCwd.isError, true, toolText(bashCwd));
        assert.match(
            (bashCwd.structuredContent as { stdout?: string }).stdout ?? "",
            /command-cwd/,
        );
        const bashEscapeCwd = await mcp.callTool("bash", {
            command: "echo nope",
            cwd: "../outside",
        });
        assertToolError(bashEscapeCwd, "bash cwd escape");

        const bashTail = await mcp.callTool("bash", {
            command:
                process.platform === "win32"
                    ? "Write-Output ('x' * 20000)"
                    : "printf '%20000s' x",
            output_mode: "tail",
            max_output_chars: 1_000,
        });
        assert.notEqual(bashTail.isError, true, toolText(bashTail));
        const bashTailData = bashTail.structuredContent as {
            stdout?: string;
            outputTruncated?: boolean;
        };
        assert.equal(bashTailData.outputTruncated, true);
        assert.ok((bashTailData.stdout ?? "").length < 1_100);
        assert.match(bashTailData.stdout ?? "", /x$/);

        const bashFail = await mcp.callTool("bash", {
            command: "exit 7",
        });
        assertToolError(bashFail, "bash non-zero");

        if (process.platform !== "win32") {
            const timeoutStarted = Date.now();
            const bashTimeout = await mcp.callTool("bash", {
                command: "trap '' TERM; while :; do sleep 1; done",
                timeout_ms: 250,
            });
            assertToolError(bashTimeout, "bash timeout escalation");
            assert.equal(
                (bashTimeout.structuredContent as { timedOut?: boolean }).timedOut,
                true,
            );
            assert.ok(Date.now() - timeoutStarted < 5_000, "bash timeout should escalate to SIGKILL");
        }

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

        const execCwd = await mcp.callTool("exec_command", {
            command: process.platform === "win32" ? "(Get-Location).Path" : "pwd",
            cwd: "command-cwd",
            output_mode: "tail",
            yield_time_ms: 5_000,
        });
        assert.notEqual(execCwd.isError, true, toolText(execCwd));
        assert.match(
            (execCwd.structuredContent as { output?: string }).output ?? "",
            /command-cwd/,
        );

        const execFail = await mcp.callTool("exec_command", {
            command: "exit 9",
            yield_time_ms: 5_000,
        });
        assertToolError(execFail, "exec_command non-zero");
        assert.equal(
            (execFail.structuredContent as { exitCode?: number }).exitCode,
            9,
        );

        // exec_command long-running → processId → write_stdin poll → process_kill
        const execBg = await mcp.callTool("exec_command", {
            command:
                process.platform === "win32"
                    ? "Start-Sleep -Milliseconds 700; Write-Output 'managed-late'; Start-Sleep -Seconds 60"
                    : "sleep 0.7; printf 'managed-late\\n'; sleep 60",
            name: "e2e-managed",
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

        const reconnectMcp = await connectMcpClient(ctx.mcpUrl);
        try {
            const processList = await reconnectMcp.callTool("process_list", {});
            assert.notEqual(processList.isError, true, toolText(processList));
            const processRows = (processList.structuredContent as {
                processes?: Array<{ processId: number; name?: string }>;
            }).processes ?? [];
            assert.ok(
                processRows.some(
                    (process) =>
                        process.processId === processId && process.name === "e2e-managed",
                ),
                "process_list should recover the process handle across MCP sessions",
            );

            const processStatus = await reconnectMcp.callTool("process_status", { processId });
            assert.notEqual(processStatus.isError, true, toolText(processStatus));
            assert.equal(
                (processStatus.structuredContent as { running?: boolean; name?: string }).name,
                "e2e-managed",
            );

            await new Promise((resolve) => setTimeout(resolve, 800));
            const processOutput = await reconnectMcp.callTool("process_output", { processId });
            assert.notEqual(processOutput.isError, true, toolText(processOutput));
            const processOutputData = processOutput.structuredContent as {
                output?: string;
                outputMode?: string;
            };
            assert.match(processOutputData.output ?? "", /managed-late/);
            assert.equal(processOutputData.outputMode, "summary");

            const poll = await reconnectMcp.callTool("write_stdin", {
                processId,
                yield_time_ms: 200,
            });
            assert.notEqual(poll.isError, true, toolText(poll));
            assert.equal(
                (poll.structuredContent as { running?: boolean }).running,
                true,
                "a second MCP session for the same local owner must see the process",
            );
            assert.equal(
                (poll.structuredContent as { outputMode?: string }).outputMode,
                "summary",
            );
            assert.match(
                (poll.structuredContent as { output?: string }).output ?? "",
                /managed-late/,
                "process_output must not consume buffered output before write_stdin",
            );

            const killed = await reconnectMcp.callTool("process_kill", {
                processId,
            });
            assert.notEqual(killed.isError, true, toolText(killed));
            assert.equal(
                (killed.structuredContent as { running?: boolean }).running,
                false,
                toolText(killed),
            );
        } finally {
            await reconnectMcp.close().catch(() => undefined);
        }

        const killMiss = await mcp.callTool("process_kill", {
            processId,
        });
        assertToolError(killMiss, "process_kill unknown id");

        const runtimeStatus = await mcp.callTool("runtime_status", {});
        assert.notEqual(runtimeStatus.isError, true, toolText(runtimeStatus));
        const runtimeData = runtimeStatus.structuredContent as {
            sampleWindow?: number;
            tools?: Array<{
                tool: string;
                calls: number;
                errors: number;
                p50Ms: number;
                p95Ms: number;
                responseBytes: { total: number; average: number; max: number };
            }>;
            http?: { requests: number; active: number; aborted: number };
            processes?: {
                running: number;
                retained: number;
                bufferedChars: number;
                starts: number;
                completions: number;
                outputTruncations: number;
            };
        };
        assert.equal(runtimeData.sampleWindow, 256);
        assert.ok((runtimeData.http?.requests ?? 0) > 0);
        assert.ok((runtimeData.http?.active ?? 0) >= 1, "runtime_status should observe its own active HTTP request");
        const readMetric = runtimeData.tools?.find((metric) => metric.tool === "read");
        assert.ok(readMetric && readMetric.calls >= 1);
        assert.ok((readMetric?.responseBytes.total ?? 0) > 0);
        assert.ok((runtimeData.processes?.starts ?? 0) >= 3);
        assert.ok((runtimeData.processes?.completions ?? 0) >= 3);
        assert.equal(runtimeData.processes?.running, 0);

        // grep hit + empty
        const grepHit = await mcp.callTool("grep", {
            pattern: "unique-marker-beta",
        });
        assert.notEqual(grepHit.isError, true, toolText(grepHit));
        const grepHitStructured = grepHit.structuredContent as {
            matches?: Array<{ path: string; line: number; column: number; text: string; kind: string }>;
        };
        assert.ok(
            (grepHitStructured.matches ?? []).some(
                (match) => match.text.includes("unique-marker-beta") && match.kind === "match",
            ),
        );

        const grepEmpty = await mcp.callTool("grep", {
            pattern: "no-such-pattern-qqq-123",
        });
        assert.notEqual(grepEmpty.isError, true, toolText(grepEmpty));
        assert.equal((grepEmpty.structuredContent as { matchCount?: number }).matchCount, 0);

        await mkdir(join(ctx.fixtureRoot, "grep-options"), { recursive: true });
        await writeFile(
            join(ctx.fixtureRoot, "grep-options", "keep.ts"),
            "before\nadvanced-grep-marker\nafter\n",
            "utf8",
        );
        await writeFile(
            join(ctx.fixtureRoot, "grep-options", "skip.spec.ts"),
            "advanced-grep-marker\n",
            "utf8",
        );
        const grepFiltered = await mcp.callTool("grep", {
            pattern: "advanced-grep-marker",
            path: "grep-options",
            glob: "**/*.ts",
            exclude: "**/*.spec.ts",
            before_context: 1,
            after_context: 1,
            max_results: 10,
        });
        assert.notEqual(grepFiltered.isError, true, toolText(grepFiltered));
        const grepFilteredMatches = (grepFiltered.structuredContent as {
            matches?: Array<{ path: string; text: string; kind: string }>;
        }).matches ?? [];
        assert.ok(grepFilteredMatches.some((match) => match.path.endsWith("grep-options/keep.ts")));
        assert.ok(
            grepFilteredMatches.some(
                (match) => match.text.includes("before") && match.kind === "context",
            ),
        );
        assert.ok(grepFilteredMatches.every((match) => !match.path.includes("skip.spec.ts")));

        const grepTightBudget = await mcp.callTool("grep", {
            pattern: "advanced-grep-marker",
            path: "grep-options/keep.ts",
            before_context: 1,
            after_context: 1,
            max_results: 1,
        });
        assert.notEqual(grepTightBudget.isError, true, toolText(grepTightBudget));
        const grepTightMatches = (grepTightBudget.structuredContent as {
            matches?: Array<{ text: string; kind: string }>;
        }).matches ?? [];
        assert.equal(grepTightMatches.length, 1);
        assert.equal(grepTightMatches[0]?.kind, "match");
        assert.match(grepTightMatches[0]?.text ?? "", /advanced-grep-marker/);

        const grepFilesOnly = await mcp.callTool("grep", {
            pattern: "advanced-grep-marker",
            path: "grep-options",
            files_only: true,
            max_results: 1,
        });
        assert.notEqual(grepFilesOnly.isError, true, toolText(grepFilesOnly));
        const grepFilesOnlyData = grepFilesOnly.structuredContent as {
            matches?: unknown[];
            files?: string[];
        };
        assert.equal((grepFilesOnlyData.matches ?? []).length, 0);
        assert.equal((grepFilesOnlyData.files ?? []).length, 1);

        // glob hit + empty + true recursive globstar
        await mkdir(join(ctx.fixtureRoot, "deep", "nested"), { recursive: true });
        await writeFile(
            join(ctx.fixtureRoot, "deep", "nested", "deep.ts"),
            "export const deep = true;\n",
            "utf8",
        );
        await writeFile(
            join(ctx.fixtureRoot, "deep", "nested", "deep.spec.ts"),
            "export const skipped = true;\n",
            "utf8",
        );
        const globHit = await mcp.callTool("glob", {
            pattern: "**/*.txt",
        });
        assert.notEqual(globHit.isError, true, toolText(globHit));
        const globFiles = (globHit.structuredContent as { files?: string[] }).files ?? [];
        assert.ok(
            globFiles.some((file) => file.replaceAll("\\", "/").endsWith("hello.txt")),
            `glob **/*.txt should include hello.txt, got: ${JSON.stringify(globFiles)}`,
        );

        const deepGlob = await mcp.callTool("glob", { pattern: "**/*.ts" });
        assert.notEqual(deepGlob.isError, true, toolText(deepGlob));
        const deepFiles = (deepGlob.structuredContent as { files?: string[] }).files ?? [];
        assert.ok(
            deepFiles.includes("deep/nested/deep.ts"),
            `recursive glob should include deep/nested/deep.ts: ${JSON.stringify(deepFiles)}`,
        );

        const scopedGlob = await mcp.callTool("glob", {
            pattern: "**/*.ts",
            path: "deep",
            exclude: "**/*.spec.ts",
            max_results: 1,
        });
        assert.notEqual(scopedGlob.isError, true, toolText(scopedGlob));
        const scopedFiles = (scopedGlob.structuredContent as { files?: string[] }).files ?? [];
        assert.deepEqual(scopedFiles, ["deep/nested/deep.ts"]);

        const globEmpty = await mcp.callTool("glob", {
            pattern: "**/*.nope-extension",
        });
        assert.notEqual(globEmpty.isError, true, toolText(globEmpty));
        assert.equal((globEmpty.structuredContent as { count?: number }).count, 0);

        // A static path prefix must narrow traversal before the global discovery cap.
        // The tiny test cap simulates a very large workspace without creating 50k files.
        await mkdir(join(ctx.fixtureRoot, "aaa-noise"), { recursive: true });
        await Promise.all(
            ["1.txt", "2.txt", "3.txt"].map((name) =>
                writeFile(join(ctx.fixtureRoot, "aaa-noise", name), "noise\n", "utf8"),
            ),
        );
        await mkdir(join(ctx.fixtureRoot, "zzz-target"), { recursive: true });
        await writeFile(
            join(ctx.fixtureRoot, "zzz-target", "package.json"),
            "{}\n",
            "utf8",
        );
        const focusedExactGlob = await listGlobFiles(
            ctx.server.project,
            "zzz-target/package.json",
            2,
        );
        assert.deepEqual(focusedExactGlob.files, ["zzz-target/package.json"]);
        assert.equal(focusedExactGlob.scanTruncated, false);
        const focusedWildcardGlob = await listGlobFiles(
            ctx.server.project,
            "zzz-target/*.json",
            2,
        );
        assert.deepEqual(focusedWildcardGlob.files, ["zzz-target/package.json"]);
        assert.equal(focusedWildcardGlob.scanTruncated, false);
        const focusedTopLevelWildcardGlob = await listGlobFiles(
            ctx.server.project,
            "zzz-*/package.json",
            2,
        );
        assert.deepEqual(focusedTopLevelWildcardGlob.files, ["zzz-target/package.json"]);
        assert.equal(focusedTopLevelWildcardGlob.scanTruncated, false);

        const broadLimitedGlob = await listGlobFiles(ctx.server.project, "**/*.txt", 2);
        assert.equal(
            broadLimitedGlob.scanTruncated,
            true,
            "broad globs must retain the traversal safety cap",
        );

        await mkdir(join(ctx.fixtureRoot, "node_modules"), { recursive: true });
        await writeFile(
            join(ctx.fixtureRoot, "node_modules", "package.json"),
            "{}\n",
            "utf8",
        );
        const ignoredExactGlob = await listGlobFiles(
            ctx.server.project,
            "node_modules/package.json",
            2,
        );
        assert.deepEqual(ignoredExactGlob.files, []);
        const ignoredPrefixedGlob = await listGlobFiles(
            ctx.server.project,
            "node_modules/*.json",
            2,
        );
        assert.deepEqual(ignoredPrefixedGlob.files, []);

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

        // webfetch rejects non-http and SSRF destinations before connecting.
        const fetchPrivate = await mcp.callTool("webfetch", {
            url: "http://127.0.0.1:65535/private",
            format: "markdown",
        });
        assertToolError(fetchPrivate, "webfetch loopback SSRF");
        assert.match(toolText(fetchPrivate), /Private or reserved network address/i);

        const fetchBad = await mcp.callTool("webfetch", {
            url: "file:///etc/passwd",
        });
        assertToolError(fetchBad, "webfetch non-http");

        // summary checkpoint (keeps the tool loop alive)
        const summaryMissingNext = await mcp.callTool("summary", {
            summary: "Work remains but no next step was supplied",
            done: false,
        });
        assertToolError(summaryMissingNext, "summary done=false without next");

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
        await ctx.server.close().catch(() => undefined);
    }
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
