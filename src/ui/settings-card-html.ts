/** Interactive MCP Apps widget for codex-mcp UI preferences. */
export function settingsCardHtml(): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>codex-mcp settings</title>
<style>
  :root {
    color-scheme: light dark;
    --fg: var(--color-text-primary, #111827);
    --muted: var(--color-text-secondary, #667085);
    --line: var(--color-border-primary, #e4e7ec);
    --surface: var(--color-background-primary, #fff);
    --soft: var(--color-background-secondary, #f7f8fa);
    --accent: var(--color-text-info, #2563eb);
    --ok: var(--color-text-success, #15803d);
    --fail: var(--color-text-danger, #dc2626);
    --font: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: var(--color-text-primary, #f2f4f7);
      --muted: var(--color-text-secondary, #a6adbb);
      --line: var(--color-border-primary, #343a46);
      --surface: var(--color-background-primary, #202123);
      --soft: var(--color-background-secondary, #282a2f);
      --accent: var(--color-text-info, #7aa2ff);
      --ok: var(--color-text-success, #4ade80);
      --fail: var(--color-text-danger, #fb7185);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { color: var(--fg); font: 14px/1.45 var(--font); -webkit-font-smoothing: antialiased; }
  .frame { padding: 4px 0; width: 100%; }
  .card { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--surface); }
  .head { padding: 14px 16px 10px; }
  .title { margin: 0; font-size: 14px; font-weight: 680; }
  .desc { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
  .rows { border-top: 1px solid var(--line); }
  .row { display: flex; align-items: center; gap: 14px; min-height: 62px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: 0; }
  .copy { flex: 1 1 auto; min-width: 0; }
  .label { font-size: 13px; font-weight: 620; }
  .hint { margin-top: 2px; color: var(--muted); font-size: 11.5px; }
  .switch { position: relative; width: 42px; height: 24px; flex: 0 0 auto; }
  .switch input { position: absolute; opacity: 0; pointer-events: none; }
  .track { position: absolute; inset: 0; border-radius: 999px; background: color-mix(in srgb, var(--muted) 35%, transparent); transition: background .16s ease; cursor: pointer; }
  .track::after { content: ""; position: absolute; width: 18px; height: 18px; top: 3px; left: 3px; border-radius: 50%; background: var(--surface); box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: transform .16s ease; }
  input:checked + .track { background: var(--accent); }
  input:checked + .track::after { transform: translateX(18px); }
  input:disabled + .track { opacity: .55; cursor: wait; }
  .foot { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 8px 16px; border-top: 1px solid var(--line); background: var(--soft); color: var(--muted); font-size: 11.5px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: 0 0 auto; }
  .foot.ok { color: var(--ok); } .foot.ok .dot { background: var(--ok); }
  .foot.fail { color: var(--fail); } .foot.fail .dot { background: var(--fail); }
  @media (prefers-reduced-motion: reduce) { .track, .track::after { transition: none; } }
</style>
</head>
<body>
  <div class="frame">
    <section class="card" aria-label="codex-mcp 设置">
      <div class="head">
        <h1 class="title">codex-mcp 显示设置</h1>
        <p class="desc">只控制自定义 MCP 卡片，不影响工具执行、结果或日志。</p>
      </div>
      <div class="rows">
        <label class="row">
          <span class="copy">
            <span class="label">普通工具 UI</span>
            <span class="hint">read、edit、grep、bash、Git 等工具卡片</span>
          </span>
          <span class="switch">
            <input id="tools" type="checkbox" />
            <span class="track" aria-hidden="true"></span>
          </span>
        </label>
        <label class="row">
          <span class="copy">
            <span class="label">状态 UI</span>
            <span class="hint">Summary 和 Goal 进度卡片</span>
          </span>
          <span class="switch">
            <input id="status" type="checkbox" />
            <span class="track" aria-hidden="true"></span>
          </span>
        </label>
      </div>
      <div class="foot" id="foot"><span class="dot"></span><span id="message">设置保存在本机</span></div>
    </section>
  </div>
<script>
(function () {
  var tools = document.getElementById("tools");
  var status = document.getElementById("status");
  var foot = document.getElementById("foot");
  var message = document.getElementById("message");
  var current = { tools: false, status: true };
  var busy = false;

  function notifyHeight() {
    try {
      if (window.openai && typeof window.openai.notifyIntrinsicHeight === "function") {
        window.openai.notifyIntrinsicHeight({ height: Math.ceil(document.documentElement.scrollHeight) });
      }
    } catch (_error) {}
  }

  function extractUi(value) {
    if (!value || typeof value !== "object") return null;
    if (value.ui && typeof value.ui.tools === "boolean" && typeof value.ui.status === "boolean") return value.ui;
    if (value.structuredContent) {
      var fromStructured = extractUi(value.structuredContent);
      if (fromStructured) return fromStructured;
    }
    if (value.call_tool_result) {
      var fromCall = extractUi(value.call_tool_result);
      if (fromCall) return fromCall;
    }
    if (value.mcp_tool_result) {
      var fromMcp = extractUi(value.mcp_tool_result);
      if (fromMcp) return fromMcp;
    }
    return null;
  }

  function apply(next) {
    if (!next) return;
    current = { tools: !!next.tools, status: !!next.status };
    tools.checked = current.tools;
    status.checked = current.status;
  }

  function setBusy(value) {
    busy = value;
    tools.disabled = value;
    status.disabled = value;
  }

  function setMessage(text, kind) {
    message.textContent = text;
    foot.className = "foot" + (kind ? " " + kind : "");
    notifyHeight();
  }

  async function save(desired) {
    if (busy) return;
    var openai = window.openai;
    if (!openai || typeof openai.callTool !== "function") {
      apply(current);
      setMessage("当前客户端不支持卡片内修改，可直接在对话中让我修改设置", "fail");
      return;
    }
    setBusy(true);
    setMessage("正在保存…", "");
    try {
      var result = await openai.callTool("settings_update", desired);
      var saved = extractUi(result) || desired;
      apply(saved);
      try {
        if (typeof openai.setWidgetState === "function") {
          openai.setWidgetState({ ui: current });
        }
      } catch (_stateError) {}
      setMessage("已保存，并已通知 ChatGPT 刷新工具显示", "ok");
    } catch (error) {
      apply(current);
      setMessage("保存失败：" + (error && error.message ? error.message : String(error)), "fail");
    } finally {
      setBusy(false);
    }
  }

  tools.addEventListener("change", function () {
    var desired = { tools: tools.checked, status: status.checked };
    save(desired);
  });
  status.addEventListener("change", function () {
    var desired = { tools: tools.checked, status: status.checked };
    save(desired);
  });

  var initial = null;
  try { initial = extractUi(window.openai && window.openai.toolOutput); } catch (_error) {}
  if (!initial) {
    try { initial = extractUi(window.openai && window.openai.widgetState); } catch (_error2) {}
  }
  apply(initial || current);
  notifyHeight();
})();
</script>
</body>
</html>`;
}
