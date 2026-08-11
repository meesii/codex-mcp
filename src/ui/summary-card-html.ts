export function summaryCardHtml(): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>codex-mcp summary</title>
<style>
  :root {
    color-scheme: light dark;
    --fg: var(--color-text-primary, #111827);
    --muted: var(--color-text-secondary, #667085);
    --faint: var(--color-text-tertiary, #98a2b3);
    --line: var(--color-border-primary, var(--color-border-light, #e4e7ec));
    --line-strong: var(--color-border-secondary, #d0d5dd);
    --surface: var(--color-background-primary, #ffffff);
    --surface-soft: var(--color-background-secondary, #f7f8fa);
    --accent: var(--color-text-info, #2563eb);
    --ok: var(--color-text-success, var(--color-border-success, #15803d));
    --fail: var(--color-text-danger, var(--color-border-danger, #dc2626));
    --progress: var(--color-text-info, #2563eb);
    --radius: var(--border-radius-lg, 10px);
    --radius-sm: var(--border-radius-sm, 6px);
    --font: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: var(--color-text-primary, #f2f4f7);
      --muted: var(--color-text-secondary, #a6adbb);
      --faint: var(--color-text-tertiary, #707887);
      --line: var(--color-border-primary, var(--color-border-light, #343a46));
      --line-strong: var(--color-border-secondary, #454c59);
      --surface: var(--color-background-primary, #202123);
      --surface-soft: var(--color-background-secondary, #282a2f);
      --accent: var(--color-text-info, #7aa2ff);
      --ok: var(--color-text-success, var(--color-border-success, #4ade80));
      --fail: var(--color-text-danger, var(--color-border-danger, #fb7185));
      --progress: var(--color-text-info, #7aa2ff);
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
    --rail: var(--accent);
    position: relative;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
    width: 100%;
    max-width: 100%;
    box-shadow: 0 1px 2px color-mix(in srgb, var(--fg) 5%, transparent);
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
  .shell.running, .shell.progress { --rail: var(--progress); }
  .shell.success { --rail: var(--ok); }
  .shell.failure { --rail: var(--fail); }
  .head {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 46px;
    padding: 10px 12px 10px 14px;
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
  }
  .icon-svg.loading { color: var(--progress); }
  .icon-svg.ok { color: var(--ok); }
  .icon-svg.progress { color: var(--progress); }
  .icon-svg.fail { color: var(--fail); }
  .icon-svg.loading .arc {
    transform-origin: 12px 12px;
    animation: spin 0.75s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .tool {
    flex: 0 0 auto;
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
  .status {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
    font-weight: 450;
    color: var(--muted);
  }
  .shell.success .status { color: var(--ok); }
  .shell.failure .status { color: var(--fail); }
  .panel {
    padding: 12px 12px 13px 14px;
    border-top: 1px solid var(--line);
    background: var(--surface-soft);
  }
  .shell.running .panel { display: none; }
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
    padding: 7px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  }
  .row:last-child { border-bottom: 0; }
  .row dt {
    margin: 0;
    color: var(--faint);
    font-size: 10px;
    line-height: 1.6;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .row dd {
    margin: 0;
    min-width: 0;
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .row:first-child dd {
    font-size: 13px;
    font-weight: 520;
  }
  .row.outcome dd { color: var(--muted); }
  .row.outcome.ok dd { color: var(--ok); }
  .row.outcome.progress dd { color: var(--progress); }
  .row.outcome.fail dd { color: var(--fail); }
  @media (max-width: 440px) {
    .head { gap: 7px; padding-right: 10px; }
    .row { grid-template-columns: 4em minmax(0, 1fr); gap: 9px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .icon-svg.loading .arc { animation: none; }
  }
</style>
</head>
<body>
  <div class="frame">
    <section class="shell running" id="shell" aria-label="进度汇报">
      <div class="head">
        <span class="icon" id="icon" aria-hidden="true"></span>
        <span class="tool" id="tool">进度汇报</span>
        <span class="status" id="status">正在总结…</span>
      </div>
      <div class="panel" id="panel"></div>
    </section>
  </div>
<script>
(function () {
  var shell = document.getElementById("shell");
  var iconEl = document.getElementById("icon");
  var toolEl = document.getElementById("tool");
  var statusEl = document.getElementById("status");
  var panel = document.getElementById("panel");
  var lastKey = "";

  function notifyHeight(forcedHeight) {
    try {
      if (window.openai && typeof window.openai.notifyIntrinsicHeight === "function") {
        var measured = Math.ceil(document.documentElement.scrollHeight);
        var height = typeof forcedHeight === "number" ? forcedHeight : Math.max(48, measured);
        window.openai.notifyIntrinsicHeight({ height: height });
      }
    } catch (_error) {}
  }

  notifyHeight(56);

  function isMobileHost() {
    try {
      var openai = window.openai;
      if (openai) {
        var ua = openai.userAgent;
        if (typeof ua === "string" && /Mobile|Android|iPhone|iPad|iPod/i.test(ua)) return true;
        if (ua && typeof ua === "object") {
          var device = ua.device || ua.deviceType || ua.platform || ua.type;
          if (typeof device === "string" && /mobile|phone|tablet|ios|android/i.test(device)) return true;
          if (ua.mobile === true || ua.isMobile === true) return true;
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

  function iconSvg(kind) {
    if (kind === "loading") {
      return '<svg class="icon-svg loading" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.2" stroke-width="2.5"></circle>' +
        '<path class="arc" d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"></path>' +
        "</svg>";
    }
    if (kind === "ok") {
      return '<svg class="icon-svg ok" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.14"></circle>' +
        '<path d="M7.2 12.3l3.1 3.1 6.5-6.5" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"></path>' +
        "</svg>";
    }
    if (kind === "progress") {
      return '<svg class="icon-svg progress" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.12"></circle>' +
        '<path d="M8 12h7.5M12.5 8.5L16 12l-3.5 3.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path>' +
        "</svg>";
    }
    return '<svg class="icon-svg fail" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.14"></circle>' +
      '<path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"></path>' +
      "</svg>";
  }

  function findUiCard(result) {
    if (!result || typeof result !== "object") return null;
    if (result.uiCard && typeof result.uiCard === "object") return result.uiCard;
    var meta = result._meta || result.meta;
    if (meta && meta.uiCard && typeof meta.uiCard === "object") return meta.uiCard;
    return null;
  }

  function unwrapEnvelope(result) {
    if (!result || typeof result !== "object") return null;
    if (result.mcp_tool_result && typeof result.mcp_tool_result === "object") return result.mcp_tool_result;
    if (result.call_tool_result && typeof result.call_tool_result === "object") return result.call_tool_result;
    return result;
  }

  function readToolInput() {
    try {
      var openai = window.openai;
      if (!openai) return null;
      var input = openai.toolInput || openai.toolArgs || openai.widgetProps;
      if (input && typeof input === "object" && !Array.isArray(input)) {
        if (input.arguments && typeof input.arguments === "object") return input.arguments;
        return input;
      }
    } catch (_error) {}
    return null;
  }

  function paintRunning() {
    shell.className = "shell running";
    iconEl.innerHTML = iconSvg("loading");
    toolEl.textContent = "进度汇报";
    statusEl.textContent = "正在总结…";
    panel.innerHTML = "";
    notifyHeight();
  }

  function paintCard(card) {
    var ok = card.ok !== false;
    var done = card.done === true;
    var kind = !ok ? "fail" : done ? "ok" : "progress";
    var summaryText = String(card.summaryText || card.title || "").trim() || "—";
    var nextText = card.nextText != null ? String(card.nextText).trim() : "";
    var outcome = !ok ? "调用失败" : done ? "任务完成" : "继续下一阶段";

    shell.className = "shell " + (kind === "ok" ? "success" : kind === "fail" ? "failure" : "progress");
    iconEl.innerHTML = iconSvg(kind);
    toolEl.textContent = done ? "任务完成" : "进度汇报";
    statusEl.textContent = outcome;
    statusEl.title = outcome;

    var rows = [
      '<div class="row"><dt>总结</dt><dd>' + escapeHtml(summaryText) + "</dd></div>"
    ];
    if (!done && nextText) {
      rows.push('<div class="row"><dt>下一步</dt><dd>' + escapeHtml(nextText) + "</dd></div>");
    }
    rows.push(
      '<div class="row outcome ' + kind + '"><dt>结果</dt><dd>' +
        escapeHtml(outcome) +
        "</dd></div>"
    );
    panel.innerHTML = '<dl class="rows">' + rows.join("") + "</dl>";

    requestAnimationFrame(function () {
      notifyHeight();
      setTimeout(notifyHeight, 120);
    });
  }

  function cardFromResult(raw) {
    var result = unwrapEnvelope(raw);
    if (!result) return null;
    var structured =
      result.structuredContent && typeof result.structuredContent === "object"
        ? result.structuredContent
        : null;
    var uiCard = findUiCard(result) || findUiCard(raw);
    var args = readToolInput() || {};
    var ok = result.isError ? false : true;

    if (uiCard && typeof uiCard === "object") {
      return {
        ok: uiCard.ok !== false && ok,
        done: uiCard.done === true || (structured && structured.done === true),
        summaryText: uiCard.summaryText || uiCard.title || (structured && structured.summary) || args.summary || "",
        nextText: uiCard.nextText != null
          ? uiCard.nextText
          : (structured && structured.next) || args.next || null,
        running: false
      };
    }

    if (!structured && !args.summary) return null;
    return {
      ok: ok,
      done: !!(structured && structured.done === true) || args.done === true,
      summaryText: (structured && structured.summary) || args.summary || "",
      nextText: (structured && structured.next) || args.next || null,
      running: false
    };
  }

  function renderFromHost() {
    applyViewportClass();
    try {
      var openai = window.openai;
      var output = openai && (openai.toolOutput || openai.toolResult);
      if (output == null) {
        paintRunning();
        return;
      }
      var card = cardFromResult(output);
      if (!card) {
        paintRunning();
        return;
      }
      var key = JSON.stringify(card);
      if (key === lastKey) return;
      lastKey = key;
      paintCard(card);
    } catch (_error) {
      paintRunning();
    }
  }

  window.addEventListener("openai:set_globals", renderFromHost);
  window.addEventListener("openai:tool_response", renderFromHost);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") renderFromHost();
  });
  applyViewportClass();
  paintRunning();
  renderFromHost();
  setTimeout(renderFromHost, 50);
  setTimeout(renderFromHost, 250);
})();
</script>
</body>
</html>`;
}
