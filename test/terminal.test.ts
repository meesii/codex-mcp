import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
    printCompactLog,
    printError,
    printInfo,
    printSummary,
} from "../src/lib/terminal.js";

function capture(run: (output: PassThrough) => void): string {
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
    });
    run(output);
    return text;
}

function main(): void {
    const summary = capture((output) => {
        printSummary(
            "已启动",
            [
                { label: "连接地址", value: "http://127.0.0.1:3920/mcp" },
                { label: "文件日志", value: "/tmp/codex-mcp/logs" },
            ],
            output,
        );
    });
    assert.match(summary, /已启动/);
    assert.match(summary, /连接地址\s+http:\/\/127\.0\.0\.1:3920\/mcp/);
    assert.match(summary, /文件日志\s+\/tmp\/codex-mcp\/logs/);
    assert.doesNotMatch(summary, /\u001b\[/, "non-TTY output must not contain ANSI escapes");

    assert.match(capture((output) => printInfo("准备完成", output)), /准备完成/);
    assert.match(capture((output) => printError("启动失败", output)), /启动失败/);

    const compact = capture((output) => {
        printCompactLog("success", "10:00:00  read  2ms", output);
    });
    assert.equal(compact.split("\n").filter(Boolean).length, 1);

    console.log("terminal.test.ts: ok");
}

main();
