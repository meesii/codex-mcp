/**
 * Compact MCP Apps HTML widget (one shared template for all tools).
 * Tool name/args come from the host (`toolInput` / notifications) or `_meta.uiCard`.
 * Optional `toolName` is only used for legacy per-tool URI aliases.
 *
 * @param toolName - Optional baked tool name (legacy URI compatibility)
 * @returns HTML document string
 */
export function toolCardHtml(toolName?: string): string {
    const bakedTool = JSON.stringify(toolName ?? "");
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>codex-mcp</title>
<style>
  :root {
    color-scheme: light dark;
    /* Host tokens win; these fallbacks are tuned to ChatGPT's light surface. */
    --fg: var(--color-text-primary, #111827);
    --muted: var(--color-text-secondary, #667085);
    --faint: var(--color-text-tertiary, #98a2b3);
    --line: var(--color-border-primary, var(--color-border-light, #e4e7ec));
    --line-strong: var(--color-border-secondary, #d0d5dd);
    --surface: var(--color-background-primary, #ffffff);
    --surface-soft: var(--color-background-secondary, #f7f8fa);
    --surface-hover: var(--color-background-tertiary, #f2f4f7);
    --accent: var(--color-text-info, #2563eb);
    --ok: var(--color-text-success, var(--color-border-success, #15803d));
    --fail: var(--color-text-danger, var(--color-border-danger, #dc2626));
    --ring: var(--color-ring-primary, var(--color-text-info, #2563eb));
    --rail: var(--faint);
    --radius: var(--border-radius-lg, 10px);
    --radius-sm: var(--border-radius-sm, 6px);
    --font: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
    --font-mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    --strip-h: 46px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      /* Used when the host does not expose design tokens. */
      --fg: var(--color-text-primary, #f2f4f7);
      --muted: var(--color-text-secondary, #a6adbb);
      --faint: var(--color-text-tertiary, #707887);
      --line: var(--color-border-primary, var(--color-border-light, #343a46));
      --line-strong: var(--color-border-secondary, #454c59);
      --surface: var(--color-background-primary, #202123);
      --surface-soft: var(--color-background-secondary, #282a2f);
      --surface-hover: var(--color-background-tertiary, #303239);
      --accent: var(--color-text-info, #7aa2ff);
      --ok: var(--color-text-success, var(--color-border-success, #4ade80));
      --fail: var(--color-text-danger, var(--color-border-danger, #fb7185));
      --ring: var(--color-ring-primary, var(--color-text-info, #7aa2ff));
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    width: 100%;
    height: auto;
    min-height: 0;
    background: transparent !important;
  }
  body {
    font: 14px/1.45 var(--font);
    color: var(--fg);
    -webkit-font-smoothing: antialiased;
  }
  .frame {
    width: 100%;
    margin: 0;
    padding: 4px 0;
  }
  html.is-mobile .frame {
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
  }
  .shell {
    --rail: var(--faint);
    position: relative;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    overflow: hidden;
    width: 100%;
    max-width: 100%;
    box-shadow: 0 1px 2px color-mix(in srgb, var(--fg) 5%, transparent);
    transition: border-color 0.16s ease, background-color 0.16s ease;
  }
  .shell::before {
    content: "";
    position: absolute;
    z-index: 2;
    inset: 8px auto 8px 0;
    width: 3px;
    border-radius: 0 999px 999px 0;
    background: var(--rail);
  }
  .shell.running { --rail: var(--accent); }
  .shell.success { --rail: var(--ok); }
  .shell.failure { --rail: var(--fail); }
  .shell.open {
    border-color: var(--line-strong);
    background: var(--surface);
  }
  .strip {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 9px;
    min-height: var(--strip-h);
    height: auto;
    padding: 10px 10px 10px 14px;
    border: 0;
    border-radius: 0;
    background: transparent;
    cursor: pointer;
    user-select: none;
    box-sizing: border-box;
    width: 100%;
    text-align: left;
    color: inherit;
    font: inherit;
    transition: background-color 0.14s ease;
  }
  .strip:not(:disabled):hover { background: var(--surface-hover); }
  .strip:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }
  .strip:disabled { cursor: default; }
  .icon {
    width: 18px;
    height: 18px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
  }
  .icon-svg {
    width: 18px;
    height: 18px;
    display: block;
    vertical-align: middle;
  }
  .icon-svg.loading { color: var(--accent); }
  .icon-svg.ok { color: var(--ok); }
  .icon-svg.fail { color: var(--fail); }
  .icon-svg.loading .arc {
    transform-origin: 12px 12px;
    animation: spin 0.75s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .tool {
    flex: 0 0 auto;
    max-width: 10em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 7px 3px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface-soft);
    color: var(--fg);
    font-size: 11px;
    line-height: 1.25;
    font-weight: 650;
    letter-spacing: 0.015em;
  }
  .title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: 12.5px/1.4 var(--font-mono);
    color: var(--muted);
    letter-spacing: -0.01em;
  }
  .shell.pending .title {
    flex: 0 1 auto;
    font-family: var(--font);
    font-size: 13px;
    color: var(--muted);
  }
  .shell.pending .chev { display: none; }
  .shell.pending .strip { justify-content: flex-start; }
  .chev {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    display: grid;
    place-items: center;
    color: var(--faint);
    background: transparent;
    transition: color 0.14s ease, background-color 0.14s ease;
  }
  .strip:not(:disabled):hover .chev {
    color: var(--muted);
    background: var(--surface-soft);
  }
  .chev svg {
    width: 14px;
    height: 14px;
    transition: transform 0.18s ease;
  }
  .shell.open .chev svg { transform: rotate(180deg); }
  .drawer {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.18s ease;
  }
  .shell.open .drawer { grid-template-rows: 1fr; }
  .drawer-inner {
    overflow: hidden;
    min-height: 0;
  }
  .panel {
    padding: 11px 12px 13px 14px;
    border-top: 0;
    max-height: none;
    overflow: visible;
    background: var(--surface-soft);
  }
  .shell.open .panel { border-top: 1px solid var(--line); }
  .rows {
    margin: 0;
    display: grid;
    gap: 0;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(54px, 4.5em) minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    padding: 6px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  }
  .row:last-child { border-bottom: 0; }
  .row dt {
    margin: 0;
    color: var(--faint);
    font-size: 10px;
    line-height: 1.55;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .row dd {
    margin: 0;
    min-width: 0;
    word-break: break-word;
    color: var(--fg);
    font: 12px/1.55 var(--font-mono);
  }
  .row.outcome dd {
    font-family: var(--font);
    font-size: 12.5px;
  }
  .row.outcome.fail dd { color: var(--fail); }
  .shell.success .row.outcome:not(.fail) dd { color: var(--ok); }
  .empty {
    padding: 3px 0;
    color: var(--muted);
    font-size: 12.5px;
  }
  @media (max-width: 440px) {
    .strip { gap: 7px; padding-right: 8px; }
    .tool { max-width: 8em; }
    .row { grid-template-columns: 4em minmax(0, 1fr); gap: 9px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .shell, .strip, .chev { transition: none; }
    .icon-svg.loading .arc { animation: none; }
    .chev svg { transition: none; }
    .drawer { transition: none; }
  }
</style>
</head>
<body>
  <div class="frame">
    <div id="shell" class="shell running">
      <button type="button" id="strip" class="strip" aria-expanded="false" aria-controls="drawer">
        <span class="icon" id="statusIcon" aria-hidden="true"></span>
        <span class="tool" id="toolChip" hidden></span>
        <span class="title" id="title">工具调用中...</span>
        <span class="chev" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </span>
      </button>
      <div id="drawer" class="drawer">
        <div class="drawer-inner">
          <div id="panel" class="panel"></div>
        </div>
      </div>
    </div>
  </div>
  <script>
(function () {
  var shell = document.getElementById("shell");
  var strip = document.getElementById("strip");
  var statusIcon = document.getElementById("statusIcon");
  var toolChip = document.getElementById("toolChip");
  var titleEl = document.getElementById("title");
  var panel = document.getElementById("panel");
  var expanded = false;
  var lastKey = "";
  var currentCard = null;
  var pollTimer = null;
  var pollAttempts = 0;
  var knownTool = ${bakedTool} || "";
  var knownArgs = null;
  var STRIP_HEIGHT = 56;
  var ARG_KEYS = ["path", "command", "pattern", "url", "processId", "format", "offset", "limit", "chars"];

  function iconSvg(kind) {
    if (kind === "loading") {
      return '<svg class="icon-svg loading" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.2" opacity="0.22"></circle>' +
        '<path class="arc" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"></path>' +
        "</svg>";
    }
    if (kind === "ok") {
      return '<svg class="icon-svg ok" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.14"></circle>' +
        '<path d="M7.2 12.3l3.1 3.1 6.5-6.5" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"></path>' +
        "</svg>";
    }
    return '<svg class="icon-svg fail" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.14"></circle>' +
      '<path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"></path>' +
      "</svg>";
  }

  var LABELS = {
    read: "读取文件",
    write: "写入文件",
    edit: "修改文件",
    bash: "执行命令",
    exec_command: "后台命令",
    write_stdin: "进程交互",
    process_kill: "结束进程",
    process_list: "列出进程",
    process_status: "查看进程",
    process_output: "查看进程输出",
    runtime_status: "查看运行指标",
    grep: "搜索内容",
    glob: "查找文件",
    ls: "列出目录",
    webfetch: "抓取网页",
    summary: "总结进度",
    skills_list: "列出 Codex Skills",
    skill_read: "读取 Codex Skill",
    agents_for_path: "读取项目指令",
    capabilities_reload: "刷新 Codex 能力",
    workspace_projects: "列出工作区项目",
    workspace_search: "搜索工作区",
    context_pack: "构建任务上下文",
    git_status: "读取 Git 状态",
    git_diff: "读取 Git 差异",
    git_log: "读取 Git 历史",
    git_show: "查看 Git 提交",
    git_branches: "列出 Git 分支",
    code_explore: "探索代码关系",
    mcp_servers: "列出下游 MCP",
    mcp_reconnect: "重连下游 MCP",
    mcp_tools: "列出下游工具",
    mcp_call: "调用下游工具",
    mcp_resources: "列出下游资源",
    mcp_resource_read: "读取下游资源",
    mcp_prompts: "列出下游提示词",
    mcp_prompt_get: "读取下游提示词"
  };
  var PARAM_LABELS = {
    path: "路径",
    command: "命令",
    pattern: "模式",
    url: "网址",
    uri: "资源 URI",
    processId: "进程",
    chars: "输入",
    offset: "起始行",
    limit: "行数",
    format: "格式",
    summary: "总结",
    next: "下一步",
    done: "完成",
    server: "MCP",
    tool: "工具",
    name: "Skill",
    prompt: "提示词",
    query: "查询",
    revision: "版本",
    staged: "暂存区",
    project_path: "项目",
    max_depth: "深度"
  };
  var PARAM_KEYS = {
    read: ["path", "offset", "limit"],
    write: ["path"],
    edit: ["path"],
    bash: ["command"],
    exec_command: ["command", "name"],
    write_stdin: ["processId", "chars"],
    process_kill: ["processId"],
    process_list: [],
    process_status: ["processId"],
    process_output: ["processId"],
    runtime_status: [],
    grep: ["pattern", "path"],
    glob: ["pattern"],
    ls: ["path"],
    webfetch: ["url", "format"],
    summary: ["summary", "next", "done"],
    skills_list: [],
    skill_read: ["name", "path"],
    agents_for_path: ["path"],
    capabilities_reload: [],
    workspace_projects: ["max_depth"],
    workspace_search: ["pattern", "path"],
    context_pack: ["query", "path"],
    git_status: ["path"],
    git_diff: ["path", "staged"],
    git_log: ["path", "limit"],
    git_show: ["path", "revision"],
    git_branches: ["path"],
    code_explore: ["query", "project_path"],
    mcp_servers: [],
    mcp_reconnect: ["server"],
    mcp_tools: ["server"],
    mcp_call: ["server", "tool"],
    mcp_resources: ["server"],
    mcp_resource_read: ["server", "uri"],
    mcp_prompts: ["server"],
    mcp_prompt_get: ["server", "prompt"]
  };

  function labelOf(toolName) {
    if (!toolName) return "";
    return LABELS[toolName] || toolName;
  }

  function notifyHeight(forcedHeight) {
    try {
      if (window.openai && typeof window.openai.notifyIntrinsicHeight === "function") {
        var measured = Math.ceil(document.documentElement.scrollHeight);
        var height = typeof forcedHeight === "number"
          ? forcedHeight
          : Math.max(STRIP_HEIGHT, measured);
        window.openai.notifyIntrinsicHeight({ height: height });
      }
    } catch (_error) {}
  }

  // Shrink the host iframe ASAP (default host placeholder is often oversized).
  notifyHeight(STRIP_HEIGHT);

  /**
   * Detect ChatGPT mobile surface.
   * Official signals: window.openai.userAgent / safeArea (see Apps SDK reference).
   */
  function isMobileHost() {
    try {
      var openai = window.openai;
      if (openai) {
        var ua = openai.userAgent;
        if (typeof ua === "string" && /Mobile|Android|iPhone|iPad|iPod/i.test(ua)) {
          return true;
        }
        if (ua && typeof ua === "object") {
          var device = ua.device || ua.deviceType || ua.platform || ua.type;
          if (typeof device === "string" && /mobile|phone|tablet|ios|android/i.test(device)) {
            return true;
          }
          if (ua.mobile === true || ua.isMobile === true) return true;
        }
        var safe = openai.safeArea;
        var insets = safe && (safe.insets || safe);
        if (insets) {
          var left = Number(insets.left || insets.insetLeft || 0);
          var right = Number(insets.right || insets.insetRight || 0);
          if (left > 0 || right > 0) return true;
        }
      }
    } catch (_error) {}
    try {
      return window.matchMedia("(max-width: 480px) and (pointer: coarse)").matches;
    } catch (_error2) {
      return false;
    }
  }

  function applyViewportClass() {
    document.documentElement.classList.toggle("is-mobile", isMobileHost());
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function clip(text, max) {
    var one = String(text).replace(/\\s+/g, " ").trim();
    if (one.length <= max) return one;
    return one.slice(0, max) + "…";
  }

  function formatParamValue(key, value) {
    if (value === undefined || value === null || value === "") return null;
    if (key === "processId") return "#" + value;
    if (key === "chars") {
      if (typeof value === "number") return value + " 字符";
      if (typeof value === "string") {
        return value.length > 0 ? value.length + " 字符" : "(空)";
      }
    }
    if (key === "command" && typeof value === "string") return clip(value, 160);
    if (typeof value === "string") return clip(value, 96);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return null;
  }

  function summarizeCall(toolName, args) {
    var input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    var keys = PARAM_KEYS[toolName] || Object.keys(input).slice(0, 4);
    var params = [];
    keys.forEach(function (key) {
      var formatted = formatParamValue(key, input[key]);
      if (formatted == null) return;
      params.push({ label: PARAM_LABELS[key] || key, value: formatted });
    });

    var title = "—";
    if (toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "ls") {
      title = clip(String(input.path || (params[0] && params[0].value) || ""), 80) || "—";
    } else if (toolName === "bash" || toolName === "exec_command") {
      title = clip(String(input.command || ""), 80) || "—";
    } else if (toolName === "grep") {
      var pattern = String(input.pattern || "");
      var path = input.path != null ? String(input.path) : "";
      title = pattern && path
        ? clip(pattern + "  ·  " + path, 80)
        : (clip(pattern || path, 80) || "—");
    } else if (toolName === "glob") {
      title = clip(String(input.pattern || ""), 80) || "—";
    } else if (toolName === "webfetch") {
      title = clip(String(input.url || ""), 80) || "—";
    } else if (toolName === "summary") {
      title = clip(String(input.summary || ""), 80) || "—";
    } else if (toolName === "mcp_tools") {
      title = clip(String(input.server || ""), 80) || "—";
    } else if (toolName === "mcp_call") {
      var mcpServer = String(input.server || "");
      var mcpTool = String(input.tool || "");
      title = mcpServer && mcpTool
        ? clip(mcpServer + "/" + mcpTool, 80)
        : (clip(mcpServer || mcpTool, 80) || "—");
    } else if (toolName === "write_stdin" || toolName === "process_kill") {
      title = input.processId != null ? "#" + input.processId : "—";
    } else if (params[0]) {
      title = clip(params[0].value, 80);
    }
    return { title: title, params: params };
  }

  function summarizeOutcome(toolName, ok, structured, contentText) {
    if (!ok) {
      var errorText = String(contentText || "").trim();
      return errorText ? clip(errorText, 100) : "调用失败";
    }
    var data = structured && typeof structured === "object" ? structured : null;
    if (!data) {
      var text = String(contentText || "").trim();
      return text ? clip(text, 100) : "";
    }
    if (toolName === "read" && typeof data.lineCount === "number") return data.lineCount + " 行";
    if (toolName === "write" && typeof data.bytes === "number") return "写入 " + data.bytes + " 字节";
    if (toolName === "edit") {
      if (data.replaced === true) return "已替换";
      if (data.replaced === false) return "未替换";
    }
    if (toolName === "bash") {
      if (data.timedOut === true) return "超时";
      if (typeof data.exitCode === "number") return "退出码 " + data.exitCode;
    }
    if (toolName === "exec_command" || toolName === "write_stdin" || toolName === "process_kill") {
      var parts = [];
      if (typeof data.processId === "number") parts.push("#" + data.processId);
      if (data.running === true) parts.push("运行中");
      else if (typeof data.exitCode === "number") parts.push("退出码 " + data.exitCode);
      else if (typeof data.signal === "string") parts.push(data.signal);
      if (parts.length) return parts.join(" · ");
    }
    if (toolName === "grep" && typeof data.matchCount === "number") return data.matchCount + " 处匹配";
    if (toolName === "glob") {
      if (typeof data.count === "number") return data.count + " 个文件";
      if (Array.isArray(data.files)) return data.files.length + " 个文件";
    }
    if (toolName === "ls" && Array.isArray(data.entries)) return data.entries.length + " 项";
    if (toolName === "webfetch" && typeof data.bytes === "number") return data.bytes + " 字节";
    if (toolName === "summary") {
      if (data.done === true) return "任务完成";
      if (data.continueWorking === true) return "继续下一阶段";
    }
    if (toolName === "mcp_tools" && Array.isArray(data.tools)) {
      return data.tools.length + " 个工具";
    }
    if (toolName === "mcp_call") {
      var called = typeof data.tool === "string" ? data.tool : "";
      if (data.isError === true) return called ? called + " 失败" : "调用失败";
      return called ? called + " 完成" : "调用完成";
    }
    var fallback = String(contentText || "").trim();
    return fallback ? clip(fallback, 100) : "";
  }

  function textFromContent(content) {
    if (!Array.isArray(content)) return "";
    return content
      .filter(function (part) { return part && part.type === "text" && part.text; })
      .map(function (part) { return part.text; })
      .join(" ");
  }

  function isToolResultEnvelope(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (value._meta != null || value.meta != null) return true;
    if (typeof value.isError === "boolean") return true;
    if (value.structuredContent != null) return true;
    if (Array.isArray(value.content)) return true;
    if (value.mcp_tool_result != null || value.call_tool_result != null) return true;
    return false;
  }

  function unwrapEnvelope(result) {
    if (!result || typeof result !== "object") return null;
    if (result.mcp_tool_result && typeof result.mcp_tool_result === "object") {
      return result.mcp_tool_result;
    }
    if (result.call_tool_result && typeof result.call_tool_result === "object") {
      return result.call_tool_result;
    }
    if (isToolResultEnvelope(result)) return result;
    return { structuredContent: result };
  }

  function normalizeArgs(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.arguments && typeof raw.arguments === "object" && !Array.isArray(raw.arguments)) {
      return raw.arguments;
    }
    if (raw.input && typeof raw.input === "object" && !Array.isArray(raw.input)) {
      return raw.input;
    }
    if (raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)) {
      // Avoid treating a single {label,value} row as an args object.
      if (raw.params.label == null && raw.params.value == null) {
        var nested = normalizeArgs(raw.params);
        if (nested) return nested;
      }
    }
    return raw;
  }

  function pickArgs(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    var out = {};
    var found = false;
    ARG_KEYS.forEach(function (key) {
      if (obj[key] == null || obj[key] === "") return;
      out[key] = obj[key];
      found = true;
    });
    return found ? out : null;
  }

  function mergeArgs(base, next) {
    if (!next) return base;
    if (!base) return next;
    var out = {};
    Object.keys(base).forEach(function (key) { out[key] = base[key]; });
    Object.keys(next).forEach(function (key) { out[key] = next[key]; });
    return out;
  }

  function findUiCard(result) {
    if (!result || typeof result !== "object") return null;
    if (result.uiCard && typeof result.uiCard === "object") return result.uiCard;
    var meta = result._meta || result.meta;
    if (meta && meta.uiCard && typeof meta.uiCard === "object") return meta.uiCard;
    return null;
  }

  function resolveArgs(card, structured, result) {
    return (
      pickArgs(card && card.args) ||
      knownArgs ||
      readToolInput() ||
      pickArgs(structured) ||
      pickArgs(result) ||
      null
    );
  }

  function enrichCard(card, structured, result) {
    var toolName = card.tool || knownTool || "tool";
    var args = resolveArgs(card, structured, result);
    if (args) knownArgs = args;
    var call = summarizeCall(toolName, args);
    if (!card.label) card.label = labelOf(toolName);
    if (!card.tool) card.tool = toolName;
    if (!Array.isArray(card.params) || card.params.length === 0) {
      card.params = call.params;
    }
    if (!card.title || card.title === "—") {
      card.title = call.title;
    }
    if (!card.outcome && structured) {
      card.outcome = summarizeOutcome(toolName, card.ok !== false, structured, "");
    }
    card.running = false;
    return card;
  }

  function cardFromResult(raw) {
    var result = unwrapEnvelope(raw);
    if (!result) return null;
    var meta = result._meta || result.meta;
    var structured =
      result.structuredContent && typeof result.structuredContent === "object"
        ? result.structuredContent
        : pickArgs(result);
    var uiCard = findUiCard(result) || findUiCard(raw) || (meta && meta.uiCard);
    if (uiCard && typeof uiCard === "object") {
      return enrichCard(Object.assign({}, uiCard), structured, result);
    }
    var contentText = textFromContent(result.content);
    var ok = result.isError ? false : true;
    var toolName =
      (meta && typeof meta.tool === "string" && meta.tool) ||
      knownTool ||
      "tool";
    if (structured == null && !Array.isArray(result.content) && !findUiCard(raw)) {
      // Plain structuredContent blob from window.openai.toolOutput
      if (raw && typeof raw === "object" && pickArgs(raw)) {
        structured = raw;
      } else {
        return null;
      }
    }
    var args = resolveArgs(null, structured, result);
    var call = summarizeCall(toolName, args);
    return {
      tool: toolName,
      label: labelOf(toolName),
      ok: ok,
      title: call.title,
      params: call.params,
      outcome: summarizeOutcome(toolName, ok, structured, contentText),
      running: false
    };
  }

  function renderPanel(card) {
    var params = Array.isArray(card.params) ? card.params : [];
    var rows = params.map(function (row) {
      return '<div class="row"><dt>' + escapeHtml(row.label) +
        "</dt><dd>" + escapeHtml(row.value) + "</dd></div>";
    });

    if (!card.running) {
      var outcome = card.outcome ? String(card.outcome) : "";
      rows.push(
        '<div class="row outcome' + (card.ok ? "" : " fail") + '"><dt>结果</dt><dd>' +
          escapeHtml(outcome || "—") +
          "</dd></div>"
      );
    }

    panel.innerHTML = rows.length
      ? '<dl class="rows">' + rows.join("") + "</dl>"
      : '<div class="empty">暂无参数</div>';
  }

  function setExpanded(next) {
    expanded = !!next;
    strip.setAttribute("aria-expanded", expanded ? "true" : "false");
    shell.classList.toggle("open", expanded);
    requestAnimationFrame(function () {
      notifyHeight();
      setTimeout(notifyHeight, 200);
    });
  }

  function canExpand(card) {
    if (!card) return false;
    if (Array.isArray(card.params) && card.params.length > 0) return true;
    if (!card.running && card.outcome) return true;
    return false;
  }

  function paintStrip(card) {
    var label = card.label || labelOf(card.tool || knownTool);
    var hasArgsTitle = !!(card.title && card.title !== "—");
    var pending = !!(card.running && !label && !hasArgsTitle);

    if (pending) {
      toolChip.textContent = "";
      toolChip.hidden = true;
      titleEl.textContent = "工具调用中...";
      titleEl.title = "工具调用中...";
    } else {
      toolChip.textContent = label;
      toolChip.hidden = !label;
      var titleText = hasArgsTitle
        ? card.title
        : (card.running ? "工具调用中..." : "—");
      titleEl.textContent = titleText;
      titleEl.title = titleText;
    }

    strip.disabled = !canExpand(card);
    shell.classList.toggle("running", !!card.running);
    shell.classList.toggle("success", !card.running && card.ok === true);
    shell.classList.toggle("failure", !card.running && card.ok === false);
    shell.classList.toggle("pending", pending);
    statusIcon.innerHTML = card.running
      ? iconSvg("loading")
      : iconSvg(card.ok ? "ok" : "fail");

    var ariaLabel = pending
      ? "工具调用中"
      : [label, titleEl.textContent, card.running ? "进行中" : (card.ok ? "成功" : "失败")]
          .filter(Boolean)
          .join("，");
    strip.setAttribute("aria-label", ariaLabel);
  }

  function renderRunning(toolName, args) {
    if (toolName) knownTool = toolName;
    if (args) knownArgs = mergeArgs(knownArgs, args);
    var call = summarizeCall(knownTool, knownArgs);
    currentCard = {
      tool: knownTool || "",
      label: labelOf(knownTool),
      ok: true,
      title: call.title,
      params: call.params,
      outcome: "",
      running: true
    };
    var key = "running:" + JSON.stringify({
      tool: currentCard.tool,
      title: currentCard.title,
      params: currentCard.params
    });
    if (key === lastKey) return;
    lastKey = key;
    paintStrip(currentCard);
    renderPanel(currentCard);
    if (!canExpand(currentCard)) setExpanded(false);
    else notifyHeight();
  }

  function renderCard(card) {
    currentCard = card;
    knownTool = card.tool || knownTool;
    lastKey = JSON.stringify(card);
    paintStrip(card);
    renderPanel(card);
    setExpanded(false);
    if (!card.running && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function applyRaw(raw) {
    var card = cardFromResult(raw);
    if (!card) return false;
    var key = JSON.stringify(card);
    if (key === lastKey) return true;
    renderCard(card);
    return true;
  }

  function guessToolName() {
    try {
      var openai = window.openai;
      if (!openai) return "";
      // Only documented Apps SDK globals — unknown keys spam the host console.
      var meta = openai.toolResponseMetadata;
      if (meta && meta.tool) return String(meta.tool);
      if (meta && meta.name) return String(meta.name);
      var state = openai.widgetState;
      if (state && state.tool) return String(state.tool);
      if (state && state.toolName) return String(state.toolName);
    } catch (_error) {}
    return "";
  }

  function readToolInput() {
    try {
      var openai = window.openai;
      if (!openai) return null;
      // Canonical: toolInput. Optional: values we ourselves persisted in widgetState.
      var candidates = [openai.toolInput];
      var state = openai.widgetState;
      if (state) {
        candidates.push(state.toolInput, state.arguments, state.input);
      }
      for (var i = 0; i < candidates.length; i++) {
        var parsed = normalizeArgs(candidates[i]) || pickArgs(candidates[i]);
        if (parsed) return parsed;
      }
    } catch (_error) {}
    return null;
  }

  function readHost() {
    applyViewportClass();
    try {
      var openai = window.openai;
      if (!openai) {
        renderRunning(knownTool, knownArgs);
        return;
      }
      var guessed = guessToolName();
      var input = readToolInput();
      if (guessed) knownTool = guessed;
      if (input) knownArgs = mergeArgs(knownArgs, input);

      var metadata = openai.toolResponseMetadata;
      if (metadata && applyRaw(metadata)) return;
      if (openai.toolOutput != null && applyRaw(openai.toolOutput)) return;

      renderRunning(knownTool, knownArgs);
    } catch (_error) {}
  }

  strip.addEventListener("click", function () {
    if (strip.disabled || !currentCard || !canExpand(currentCard)) return;
    setExpanded(!expanded);
  });

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (
      data.method === "ui/notifications/tool-input" ||
      data.method === "ui/notifications/tool-input-partial" ||
      data.method === "ui/tool-input"
    ) {
      var params = data.params || data.payload || {};
      var name = params.name || params.toolName || params.tool || knownTool;
      var args =
        pickArgs(params) ||
        normalizeArgs(params) ||
        normalizeArgs(params.arguments) ||
        normalizeArgs(params.input) ||
        pickArgs(params.arguments) ||
        pickArgs(params.input);
      renderRunning(name ? String(name) : knownTool, args || knownArgs);
      return;
    }
    if (data.method === "ui/notifications/tool-result") {
      applyRaw(data.params);
      return;
    }
    if (data.type === "ui/notifications/tool-result") {
      applyRaw(data.payload || data.params);
    }
  });

  window.addEventListener("openai:set_globals", readHost);
  document.addEventListener("openai:set_globals", readHost);
  window.addEventListener("resize", applyViewportClass);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") readHost();
  });
  statusIcon.innerHTML = iconSvg("loading");
  applyViewportClass();
  renderRunning(knownTool || guessToolName(), readToolInput());
  readHost();
  pollTimer = setInterval(function () {
    if (document.visibilityState === "hidden") return;
    pollAttempts += 1;
    readHost();
    if (pollAttempts >= 40 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 250);
})();
  </script>
</body>
</html>`;
}
