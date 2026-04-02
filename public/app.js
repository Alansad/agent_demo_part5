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
      };

      const data = await apiPost("/api/run", body);
      renderPlan(data.plan);
      renderTimeline(data.results);
      renderFinal(data.final);
      renderTrace(data.trace);
      setStatus("完成");
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
