const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $("status").textContent = text || "";
}

function setHealth(ok, text) {
  const el = $("health");
  el.textContent = text;
  el.classList.remove("ok", "bad");
  el.classList.add(ok ? "ok" : "bad");
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMarkdownLite(md) {
  const lines = String(md ?? "").split("\n");
  const out = [];
  let inList = false;
  let inCode = false;

  const closeList = () => {
    if (inList) out.push("</ul>");
    inList = false;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");

    if (line.startsWith("```")) {
      if (!inCode) {
        closeList();
        inCode = true;
        out.push("<pre><code>");
      } else {
        inCode = false;
        out.push("</code></pre>");
      }
      continue;
    }

    if (inCode) {
      out.push(escapeHtml(line) + "\n");
      continue;
    }

    if (/^###\s+/.test(line)) {
      closeList();
      out.push(`<h3>${escapeHtml(line.replace(/^###\s+/, ""))}</h3>`);
      continue;
    }
    if (/^##\s+/.test(line)) {
      closeList();
      out.push(`<h2>${escapeHtml(line.replace(/^##\s+/, ""))}</h2>`);
      continue;
    }
    if (/^#\s+/.test(line)) {
      closeList();
      out.push(`<h1>${escapeHtml(line.replace(/^#\s+/, ""))}</h1>`);
      continue;
    }

    if (/^- /.test(line)) {
      if (!inList) {
        inList = true;
        out.push("<ul>");
      }
      out.push(`<li>${escapeHtml(line.replace(/^- /, ""))}</li>`);
      continue;
    }

    closeList();
    if (line.trim() === "") {
      out.push("<div style=\"height: 8px\"></div>");
      continue;
    }
    out.push(`<div>${escapeHtml(line)}</div>`);
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("");
}

function renderPlan(plan) {
  if (!plan?.tasks?.length) {
    $("plan").innerHTML = "<div class=\"muted\">暂无</div>";
    return;
  }

  const items = plan.tasks
    .map((t) => {
      const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
      const depsHtml = deps.length
        ? `<div class="deps">${deps.map((d) => `<span class="badge">依赖: ${escapeHtml(d)}</span>`).join("")}</div>`
        : `<div class="deps"><span class="badge">无依赖</span></div>`;

      return `
        <div class="item">
          <div class="title">
            <div><strong>${escapeHtml(t.id)}</strong> ${escapeHtml(t.title)}</div>
            <span class="badge">${escapeHtml(t.assignee)}</span>
          </div>
          <div class="muted" style="margin-top:6px">${escapeHtml(t.description)}</div>
          ${depsHtml}
        </div>
      `;
    })
    .join("");

  $("plan").innerHTML = `<div class="list">${items}</div>`;
}

function renderTimeline(results) {
  if (!Array.isArray(results) || results.length === 0) {
    $("timeline").innerHTML = "<div class=\"muted\">暂无</div>";
    return;
  }

  const min = Math.min(...results.map((r) => r.startedAt));
  const max = Math.max(...results.map((r) => r.finishedAt));
  const span = Math.max(1, max - min);

  const byAgent = new Map();
  for (const r of results) {
    const key = r.assignee || "unknown";
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(r);
  }

  const lanes = [...byAgent.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([assignee, rs]) => {
      rs.sort((a, b) => a.startedAt - b.startedAt);
      const bars = rs
        .map((r) => {
          const left = ((r.startedAt - min) / span) * 100;
          const width = (Math.max(1, r.finishedAt - r.startedAt) / span) * 100;
          const ms = r.finishedAt - r.startedAt;
          const cls = r.status === "succeeded" ? "ok" : "bad";
          const label = `${r.taskId} · ${ms}ms`;
          return `<div class="bar ${cls}" style="left:${left}%; width:${Math.min(100 - left, width)}%">${escapeHtml(label)}</div>`;
        })
        .join("");

      return `
        <div class="lane">
          <div class="laneHead">
            <div><strong>${escapeHtml(assignee)}</strong></div>
            <div class="muted">${rs.length} tasks</div>
          </div>
          <div class="laneBody">${bars}</div>
        </div>
      `;
    })
    .join("");

  $("timeline").innerHTML = `<div class="timeline">${lanes}</div>`;
}

function renderFinal(finalText) {
  $("final").innerHTML = renderMarkdownLite(finalText ?? "");
}

function renderTrace(trace) {
  $("trace").textContent = JSON.stringify(trace ?? [], null, 2);
}

function clearOutput() {
  $("plan").innerHTML = "";
  $("timeline").innerHTML = "";
  $("final").innerHTML = "";
  $("trace").textContent = "";
  setStatus("");
}

async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.stack ? `${data.error}\n\n${data.stack}` : data?.error || `${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function* sseFromFetch(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status}`);
  }
  if (!res.body) throw new Error("Streaming not supported in this browser");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  const flushEvent = () => {
    if (dataLines.length === 0) return null;
    const dataStr = dataLines.join("\n");
    dataLines = [];
    let data;
    try {
      data = JSON.parse(dataStr);
    } catch {
      data = dataStr;
    }
    return { event: eventName, data };
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);

      if (line === "") {
        const ev = flushEvent();
        if (ev) yield ev;
        eventName = "message";
        continue;
      }
      if (line.startsWith(":")) continue; // comment/ping
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim() || "message";
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
        continue;
      }
    }
  }

  const ev = flushEvent();
  if (ev) yield ev;
}

async function boot() {
  try {
    await apiGet("/api/health");
    setHealth(true, "API: ok");
  } catch {
    setHealth(false, "API: down");
  }

  const scenarios = await apiGet("/api/scenarios");
  const select = $("scenario");
  select.innerHTML = (scenarios.scenarios || [])
    .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.title)}</option>`)
    .join("");
  select.value = "frontend-agent-mvp";

  $("run").addEventListener("click", async () => {
    $("run").disabled = true;
    setStatus("运行中：规划 + 多 Agent 执行 + 汇总…");
    try {
      const body = {
        scenario: $("scenario").value,
        goal: $("goal").value,
        concurrency: Number($("concurrency").value),
        maxTasks: Number($("maxTasks").value),
        timeoutMs: Number($("timeoutMs").value),
        maxAttempts: Number($("maxAttempts").value),
        backoffMs: Number($("backoffMs").value),
        debug: $("debug").value === "true",
        failOnceAssignee: $("failOnceAssignee").value || undefined,
      };

      clearOutput();
      renderFinal("（运行中…）");
      renderTrace([]);

      const liveResults = [];
      const liveTrace = [];
      const seenResult = new Set();

      for await (const ev of sseFromFetch("/api/run/stream", body)) {
        if (ev.event === "phase") {
          setStatus(`阶段：${ev.data?.name || ""}…`);
          continue;
        }
        if (ev.event === "plan") {
          renderPlan(ev.data);
          continue;
        }
        if (ev.event === "task_result") {
          const key = `${ev.data.taskId}:${ev.data.assignee}`;
          if (!seenResult.has(key)) {
            seenResult.add(key);
            liveResults.push(ev.data);
            renderTimeline(liveResults);
          }
          continue;
        }
        if (ev.event === "trace") {
          liveTrace.push(ev.data);
          renderTrace(liveTrace);
          continue;
        }
        if (ev.event === "final") {
          renderFinal(ev.data?.final || "");
          // ensure timeline matches final results
          if (Array.isArray(ev.data?.results)) renderTimeline(ev.data.results);
          if (Array.isArray(ev.data?.trace)) renderTrace(ev.data.trace);
          continue;
        }
        if (ev.event === "done") {
          setStatus("完成");
          continue;
        }
        if (ev.event === "error") {
          const msg = ev.data?.stack ? `${ev.data.error}\n\n${ev.data.stack}` : ev.data?.error || "unknown error";
          setStatus(`失败：${msg}`);
          break;
        }
      }
    } catch (e) {
      setStatus(`失败：${e?.message || e}`);
    } finally {
      $("run").disabled = false;
    }
  });

  $("reset").addEventListener("click", clearOutput);
  $("toggleTrace").addEventListener("click", () => $("trace").classList.toggle("collapsed"));
  $("copyFinal").addEventListener("click", async () => {
    const text = $("final").textContent || "";
    try {
      await navigator.clipboard.writeText(text);
      setStatus("已复制最终报告");
      setTimeout(() => setStatus(""), 1200);
    } catch {
      setStatus("复制失败（浏览器权限限制）");
    }
  });
}

boot();
