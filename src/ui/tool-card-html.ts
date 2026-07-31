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
    /* Prefer host design tokens (Apps SDK / UI guidelines). */
    --fg: var(--color-text-primary, #111827);
    --muted: var(--color-text-secondary, #6b7280);
    --line: var(--color-border-primary, var(--color-border-light, #e5e7eb));
    --chip: var(--color-background-secondary, #f3f4f6);
    --ok: var(--color-text-success, var(--color-border-success, #067647));
    --fail: var(--color-text-danger, var(--color-border-danger, #b42318));
    --ring: var(--color-ring-primary, var(--color-text-info, #6366f1));
    --radius: var(--border-radius-md, 8px);
    --font: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
    --font-mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    --strip-h: 42px;
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
    font: 14px/1.4 var(--font);
    color: var(--fg);
  }
  /* Default: no side gutter (web already has conversation inset). */
  .frame {
    width: 100%;
    margin: 0;
    padding: 4px 0;
  }
  /* Mobile only — host may leave the iframe edge-to-edge. */
  html.is-mobile .frame {
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
  }
  .shell {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: transparent;
    overflow: hidden;
    width: 100%;
    max-width: 100%;
  }
  .strip {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    min-height: var(--strip-h);
    height: auto;
    padding: 10px 12px;
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
  }
  .strip:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }
  .strip:disabled {
    cursor: default;
  }
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
  .icon-svg.loading { color: var(--muted); }
  .icon-svg.ok { color: var(--ok); }
  .icon-svg.fail { color: var(--fail); }
  .icon-svg.loading .arc {
    transform-origin: 12px 12px;
    animation: spin 0.75s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .tool {
    flex: 0 0 auto;
    font-weight: 600;
    font-size: 13px;
    color: var(--fg);
    max-width: 8em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 400;
    color: var(--muted);
    font-family: var(--font-mono);
  }
  .shell.pending .title {
    flex: 0 1 auto;
    font-family: inherit;
    color: var(--fg);
  }
  .shell.pending .chev {
    display: none;
  }
  .shell.pending .strip {
    justify-content: flex-start;
  }
  .chev {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--muted);
    background: var(--chip);
  }
  .chev svg {
    width: 15px;
    height: 15px;
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
    padding: 10px 12px 12px;
    border-top: 0;
    /* No nested scrolling — grow with content (inline card rules). */
    max-height: none;
    overflow: visible;
  }
  .shell.open .panel {
    border-top: 1px solid var(--line);
  }
  .rows {
    margin: 0;
    display: grid;
    gap: 6px;
  }
  .row {
    display: grid;
    grid-template-columns: 3.2em 1fr;
    gap: 10px;
    align-items: baseline;
  }
  .row dt {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }
  .row dd {
    margin: 0;
    word-break: break-word;
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .row.outcome dd { font-family: var(--font); }
  .row.outcome.fail dd { color: var(--fail); }
  .empty {
    color: var(--muted);
    font-size: 13px;
  }
  @media (prefers-reduced-motion: reduce) {
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
  var knownTool = ${bakedTool} || "";
  var knownArgs = null;
  var STRIP_HEIGHT = 44;
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
    grep: "搜索内容",
    glob: "查找文件",
    ls: "列出目录",
    webfetch: "抓取网页"
  };
  var PARAM_LABELS = {
    path: "路径",
    command: "命令",
    pattern: "模式",
    url: "网址",
    processId: "进程",
    chars: "输入",
    offset: "起始行",
    limit: "行数",
    format: "格式"
  };
  var PARAM_KEYS = {
    read: ["path", "offset", "limit"],
    write: ["path"],
    edit: ["path"],
    bash: ["command"],
    exec_command: ["command"],
    write_stdin: ["processId", "chars"],
    process_kill: ["processId"],
    grep: ["pattern", "path"],
    glob: ["pattern"],
    ls: ["path"],
    webfetch: ["url", "format"]
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

  function applyHostStyles() {
    try {
      var openai = window.openai;
      var vars =
        (openai && openai.styles && openai.styles.variables) ||
        (openai && openai.themeVars) ||
        null;
      if (!vars || typeof vars !== "object") return;
      var root = document.documentElement;
      Object.keys(vars).forEach(function (key) {
        var name = key.charAt(0) === "-" ? key : "--" + key;
        if (typeof vars[key] === "string") root.style.setProperty(name, vars[key]);
      });
    } catch (_error) {}
  }

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
      if (openai.toolName) return String(openai.toolName);
      if (openai.tool && openai.tool.name) return String(openai.tool.name);
      var meta = openai.toolResponseMetadata;
      if (meta && meta.tool) return String(meta.tool);
      if (meta && meta.name) return String(meta.name);
    } catch (_error) {}
    return "";
  }

  function readToolInput() {
    try {
      var openai = window.openai;
      if (!openai) return null;
      var candidates = [
        openai.toolInput,
        openai.toolArguments,
        openai.arguments,
        openai.tool && openai.tool.input,
        openai.tool && openai.tool.arguments,
        openai.widgetProps && openai.widgetProps.toolInput,
        openai.widgetState && openai.widgetState.toolInput
      ];
      for (var i = 0; i < candidates.length; i++) {
        var parsed = normalizeArgs(candidates[i]) || pickArgs(candidates[i]);
        if (parsed) return parsed;
      }
    } catch (_error) {}
    return null;
  }

  function readHost() {
    applyHostStyles();
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
  statusIcon.innerHTML = iconSvg("loading");
  applyViewportClass();
  renderRunning(knownTool || guessToolName(), readToolInput());
  readHost();
  setInterval(readHost, 250);
})();
  </script>
</body>
</html>`;
}
