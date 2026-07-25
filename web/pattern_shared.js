/* 形态档案 — 回放页与管理页共用 */

const PATTERN_TFS = ["5m", "15m", "30m", "1h", "4h"];

function patternApiUrl(path) {
  const base = window.__API_BASE__ || "";
  return `${base}${path}`;
}

async function patternReadJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

async function patternFetch(path, options = {}) {
  const res = await fetch(patternApiUrl(path), options);
  const data = await patternReadJson(res);
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function patternScreenshotUrl(filename) {
  return patternApiUrl(`/api/patterns/screenshot/${encodeURIComponent(filename)}`);
}

function patternOutcomeLabel(outcome) {
  if (typeof t !== "function") {
    if (outcome === "success") return "成功";
    if (outcome === "fail") return "失败";
    return "未标记";
  }
  if (outcome === "success") return t("pattern.outcome.success");
  if (outcome === "fail") return t("pattern.outcome.fail");
  return t("pattern.outcome.unset");
}

function patternOutcomeBadgeClass(outcome) {
  if (outcome === "success") return "pat-outcome-success";
  if (outcome === "fail") return "pat-outcome-fail";
  return "pat-outcome-unset";
}

function renderPatternOutcomeSelect(value, { id = "", className = "pat-filter", name = "" } = {}) {
  const v = value || "";
  const idAttr = id ? ` id="${id}"` : "";
  const nameAttr = name ? ` name="${name}"` : "";
  const label = typeof t === "function" ? t("pattern.outcome.label") : "结果";
  return `<select${idAttr}${nameAttr} class="${className}" aria-label="${label}">
    <option value=""${v === "" ? " selected" : ""}>${patternOutcomeLabel("")}</option>
    <option value="success"${v === "success" ? " selected" : ""}>${patternOutcomeLabel("success")}</option>
    <option value="fail"${v === "fail" ? " selected" : ""}>${patternOutcomeLabel("fail")}</option>
  </select>`;
}

function renderPatternOutcomeFilterSelect(value, { id = "patFilterOutcome" } = {}) {
  const v = value || "";
  const all = typeof t === "function" ? t("pattern.filter.allOutcomes") : "全部结果";
  const unset = typeof t === "function" ? t("pattern.outcome.unset") : "未标记";
  const success = patternOutcomeLabel("success");
  const fail = patternOutcomeLabel("fail");
  return `<select id="${id}" class="pat-filter" aria-label="${all}">
    <option value="">${all}</option>
    <option value="unset"${v === "unset" ? " selected" : ""}>${unset}</option>
    <option value="success"${v === "success" ? " selected" : ""}>${success}</option>
    <option value="fail"${v === "fail" ? " selected" : ""}>${fail}</option>
  </select>`;
}

function patternTagById(tags, id) {
  return (tags || []).find((x) => x.id === id);
}

function patternEscapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPatternTagBadges(tagIds, tags, { className = "pat-card-tags" } = {}) {
  const rows = (tagIds || []).map((id) => patternTagById(tags, id)).filter(Boolean);
  if (!rows.length) return "";
  return `<div class="${className}">${rows
    .map((tg) => `<span class="pat-tag-badge">${patternEscapeHtml(tg.label)}</span>`)
    .join("")}</div>`;
}

function renderPatternTagPicker(selectedIds, tags, { id = "patTagPicker" } = {}) {
  const sel = new Set(selectedIds || []);
  const empty = typeof t === "function" ? t("pattern.tagsEmpty") : "暂无标签，请先在管理页创建";
  if (!tags?.length) {
    return `<p class="pat-tag-picker-empty muted">${empty}</p>`;
  }
  const label = typeof t === "function" ? t("pattern.tagsLabel") : "标签";
  return `<div class="pat-tag-picker" id="${id}" role="group" aria-label="${label}">${tags
    .map((tg) => {
      const active = sel.has(tg.id);
      return `<button type="button" class="pat-tag-chip${active ? " active" : ""}" data-tag-id="${tg.id}" aria-pressed="${active}">${patternEscapeHtml(tg.label)}</button>`;
    })
    .join("")}</div>`;
}

function renderPatternTagFilterSelect(value, tags, { id = "patFilterTag" } = {}) {
  const v = value || "";
  const all = typeof t === "function" ? t("pattern.filter.allTags") : "全部标签";
  return `<select id="${id}" class="pat-filter" aria-label="${all}">
    <option value="">${all}</option>
    ${(tags || [])
      .map(
        (tg) =>
          `<option value="${tg.id}"${v === tg.id ? " selected" : ""}>${patternEscapeHtml(tg.label)}</option>`
      )
      .join("")}
  </select>`;
}

function collectPatternTagPickerIds(root) {
  if (!root) return [];
  return [...root.querySelectorAll(".pat-tag-chip.active")].map((b) => b.dataset.tagId);
}

function bindPatternTagPicker(root, onChange) {
  if (!root) return;
  root.querySelectorAll("[data-tag-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.classList.toggle("active");
      btn.setAttribute("aria-pressed", btn.classList.contains("active") ? "true" : "false");
      onChange?.(collectPatternTagPickerIds(root));
    });
  });
}

function patternFmtTime(ts) {
  if (!ts) return "—";
  const locale = typeof getLocale === "function" && getLocale() === "en" ? "en-GB" : "zh-CN";
  const d = new Date(ts * 1000);
  const part = d.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  const utc = typeof t === "function" ? t("time.utc") : "UTC";
  return `${part} ${utc}`;
}

function renderPatternTfBadges(caseObj) {
  return PATTERN_TFS.map((tf) => {
    const has = !!(caseObj?.frames && caseObj.frames[tf]);
    const cls = has ? "pat-tf pat-tf-done" : "pat-tf pat-tf-empty";
    const mark = has ? "✓" : "○";
    return `<span class="${cls}">${tf} ${mark}</span>`;
  }).join("");
}

function patternDefaultTf(caseObj) {
  const primary = caseObj?.primary_tf;
  if (primary && caseObj.frames?.[primary]?.screenshot) return primary;
  return PATTERN_TFS.find((tf) => caseObj.frames?.[tf]?.screenshot) || "5m";
}

function renderPatternViewerMain(caseObj, activeTf) {
  const frame = caseObj.frames?.[activeTf];
  const url = frame?.screenshot ? patternScreenshotUrl(frame.screenshot) : "";
  const noFrame = typeof t === "function" ? t("pattern.noFrame") : "—";
  if (!url) {
    return `<div class="pat-viewer-empty">${noFrame}</div>`;
  }
  return `<button type="button" class="pat-frame-zoom-btn pat-viewer-main-btn" data-frame-url="${url}" data-frame-tf="${activeTf}" aria-label="${activeTf}">
    <img src="${url}" alt="${activeTf}" class="pat-viewer-main-img" />
  </button>`;
}

function renderPatternViewerStrip(caseObj, activeTf) {
  return PATTERN_TFS.map((tf) => {
    const frame = caseObj.frames?.[tf];
    const url = frame?.screenshot ? patternScreenshotUrl(frame.screenshot) : "";
    const active = tf === activeTf ? " active" : "";
    const has = !!url;
    const thumb = has
      ? `<img src="${url}" alt="" class="pat-viewer-thumb-img" loading="lazy" />`
      : `<span class="pat-viewer-thumb-empty">—</span>`;
    return `<button type="button" class="pat-viewer-thumb${active}${has ? "" : " pat-viewer-thumb-missing"}" data-viewer-tf="${tf}" role="tab" aria-selected="${tf === activeTf}">
      <span class="pat-viewer-thumb-label">${tf}</span>
      ${thumb}
    </button>`;
  }).join("");
}

function renderPatternFramesStack(caseObj) {
  const noFrame = typeof t === "function" ? t("pattern.noFrame") : "—";
  return `<div class="pat-frames-stack">
    ${PATTERN_TFS.map((tf) => {
      const frame = caseObj.frames?.[tf];
      const url = frame?.screenshot ? patternScreenshotUrl(frame.screenshot) : "";
      const body = url
        ? `<button type="button" class="pat-frame-zoom-btn pat-frame-stack-btn" data-frame-url="${url}" data-frame-tf="${tf}" aria-label="${tf}">
             <img src="${url}" alt="${tf}" class="pat-frame-stack-img" loading="lazy" />
           </button>`
        : `<div class="pat-frame-empty">${noFrame}</div>`;
      return `<section class="pat-frame-stack-item" id="pat-stack-${tf}">
        <h4 class="pat-frame-stack-label">${tf}</h4>
        <div class="pat-frame-stack-body">${body}</div>
      </section>`;
    }).join("")}
  </div>`;
}

function renderPatternDetailViewer(caseObj, { mode = "focus", activeTf } = {}) {
  const tf = activeTf || patternDefaultTf(caseObj);
  const focusActive = mode !== "stack";
  const hint = typeof t === "function" ? t("pattern.viewerHint") : "";
  return `
    <div class="pat-viewer-mode-bar">
      <button type="button" class="pat-view-mode-btn${focusActive ? " active" : ""}" data-view-mode="focus">${typeof t === "function" ? t("pattern.viewFocus") : "Focus"}</button>
      <button type="button" class="pat-view-mode-btn${!focusActive ? " active" : ""}" data-view-mode="stack">${typeof t === "function" ? t("pattern.viewStack") : "Stack"}</button>
    </div>
    <div class="pat-viewer-panel${focusActive ? "" : " hidden"}" data-viewer-panel="focus">
      <div class="pat-viewer" data-active-tf="${tf}">
        <div class="pat-viewer-main-wrap" data-viewer-main>${renderPatternViewerMain(caseObj, tf)}</div>
        <div class="pat-viewer-strip" role="tablist">${renderPatternViewerStrip(caseObj, tf)}</div>
        <p class="pat-viewer-hint muted">${hint}</p>
      </div>
    </div>
    <div class="pat-viewer-panel${focusActive ? " hidden" : ""}" data-viewer-panel="stack">
      ${renderPatternFramesStack(caseObj)}
    </div>
  `;
}

function initPatternDetailViewer(root, caseObj, { mode = "focus", activeTf } = {}) {
  if (!root) return null;
  const state = {
    mode: mode === "stack" ? "stack" : "focus",
    activeTf: activeTf || patternDefaultTf(caseObj),
    caseObj,
  };

  const mainEl = () => root.querySelector("[data-viewer-main]");
  const stripEl = () => root.querySelector(".pat-viewer-strip");

  const syncMain = () => {
    const main = mainEl();
    if (!main) return;
    main.innerHTML = renderPatternViewerMain(state.caseObj, state.activeTf);
    bindPatternFrameZoom(main);
    const viewer = root.querySelector(".pat-viewer");
    if (viewer) viewer.dataset.activeTf = state.activeTf;
    const strip = stripEl();
    if (strip) {
      strip.innerHTML = renderPatternViewerStrip(state.caseObj, state.activeTf);
      bindStrip(strip);
    }
  };

  const bindStrip = (strip) => {
    strip.querySelectorAll("[data-viewer-tf]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeTf = btn.dataset.viewerTf;
        syncMain();
      });
    });
  };

  const setMode = (next) => {
    state.mode = next;
    root.querySelectorAll("[data-viewer-panel]").forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.viewerPanel !== next);
    });
    root.querySelectorAll("[data-view-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.viewMode === next);
    });
    if (next === "focus") syncMain();
    if (next === "stack") bindPatternFrameZoom(root.querySelector('[data-viewer-panel="stack"]'));
  };

  root.querySelectorAll("[data-view-mode]").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.viewMode));
  });

  bindStrip(stripEl());
  bindPatternFrameZoom(mainEl());
  if (state.mode === "stack") bindPatternFrameZoom(root.querySelector('[data-viewer-panel="stack"]'));

  const onKey = (e) => {
    const dlg = root.closest("dialog");
    if (!dlg?.open || state.mode !== "focus") return;
    if (e.target.closest("input, textarea, select")) return;
    const idx = PATTERN_TFS.indexOf(state.activeTf);
    if (e.key === "ArrowRight" && idx < PATTERN_TFS.length - 1) {
      e.preventDefault();
      state.activeTf = PATTERN_TFS[idx + 1];
      syncMain();
    } else if (e.key === "ArrowLeft" && idx > 0) {
      e.preventDefault();
      state.activeTf = PATTERN_TFS[idx - 1];
      syncMain();
    }
  };
  document.addEventListener("keydown", onKey);

  return {
    destroy() {
      document.removeEventListener("keydown", onKey);
    },
  };
}

function renderMultiTfFrames(caseObj) {
  const noFrame = typeof t === "function" ? t("pattern.noFrame") : "—";
  return `<div class="pat-frames-grid">
    ${PATTERN_TFS.map((tf) => {
      const frame = caseObj.frames?.[tf];
      const url = frame?.screenshot ? patternScreenshotUrl(frame.screenshot) : "";
      const inner = url
        ? `<button type="button" class="pat-frame-zoom-btn" data-frame-url="${url}" data-frame-tf="${tf}" aria-label="${tf}">
             <img src="${url}" alt="${tf}" class="pat-frame-img" loading="lazy" />
           </button>`
        : `<div class="pat-frame-empty">${noFrame}</div>`;
      return `<figure class="pat-frame-cell">
        <figcaption class="pat-frame-label">${tf}</figcaption>
        ${inner}
      </figure>`;
    }).join("")}
  </div>`;
}

function openPatternFrameZoom(url, tf) {
  const dlg = document.getElementById("patternFrameZoom");
  const img = document.getElementById("patternFrameZoomImg");
  const label = document.getElementById("patternFrameZoomLabel");
  if (!dlg || !img || !url) return;
  img.src = url;
  if (label) label.textContent = tf || "";
  dlg.showModal();
}

function closePatternFrameZoom() {
  const dlg = document.getElementById("patternFrameZoom");
  const img = document.getElementById("patternFrameZoomImg");
  dlg?.close();
  if (img) img.removeAttribute("src");
}

function bindPatternFrameZoom(root) {
  if (!root) return;
  root.querySelectorAll(".pat-frame-zoom-btn[data-frame-url]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPatternFrameZoom(btn.dataset.frameUrl, btn.dataset.frameTf);
    });
  });
}

function setupPatternFrameZoomDialog() {
  const dlg = document.getElementById("patternFrameZoom");
  if (!dlg || dlg.dataset.bound) return;
  dlg.dataset.bound = "1";
  dlg.querySelector(".pattern-frame-zoom-close")?.addEventListener("click", closePatternFrameZoom);
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) closePatternFrameZoom();
  });
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    closePatternFrameZoom();
  });
}
