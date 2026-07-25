/* 回放页：形态捕获浮条 */

const patternState = {
  activeCase: null,
  types: [],
  tags: [],
  pickMode: false,
  dockMsg: "",
};

function patternApiReady() {
  return state.config?.features?.pattern_journal === true;
}

function patternTypes() {
  return patternState.types;
}

function patternTypeLabel(id) {
  const found = patternTypes().find((p) => p.id === id);
  return found?.label || id;
}

async function loadPatternTypes() {
  if (!patternApiReady()) return;
  const data = await patternFetch("/api/pattern-types");
  patternState.types = data.types || [];
}

async function loadPatternTags() {
  const data = await patternFetch("/api/pattern-tags");
  patternState.tags = data.tags || [];
}

async function loadPatternCases() {
  if (!patternApiReady()) return;
  const data = await patternFetch("/api/patterns");
  return data.cases || [];
}

async function createPatternCase(patternType) {
  const bar = state.allBars[state.cursor];
  if (!bar) {
    patternState.dockMsg = t("pattern.alert.noBar");
    patternState.pickMode = false;
    renderPatternDock();
    return null;
  }
  const body = {
    pattern_type: patternType,
    pattern_label: patternTypeLabel(patternType),
    anchor_ts: bar.time,
    primary_tf: state.timeframe,
  };
  const c = await patternFetch("/api/patterns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  patternState.activeCase = c;
  patternState.pickMode = false;
  patternState.dockMsg = "";
  renderPatternDock();
  return c;
}

async function updatePatternCase(id, patch) {
  const c = await patternFetch(`/api/patterns/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (patternState.activeCase?.id === id) patternState.activeCase = c;
  renderPatternDock();
  return c;
}

async function uploadPatternFrame(caseId, timeframe, dataUrl, view, cursorTs) {
  return patternFetch(`/api/patterns/${encodeURIComponent(caseId)}/frames`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timeframe,
      image: dataUrl,
      cursor_ts: cursorTs,
      view,
    }),
  });
}

function renderPatternDock() {
  const el = $("patternDock");
  if (!el) return;
  if (!patternApiReady()) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const c = patternState.activeCase;
  const msg = patternState.dockMsg
    ? `<span class="pat-dock-msg">${patternState.dockMsg}</span>`
    : "";
  if (!c && patternState.pickMode) {
    const types = patternTypes();
    if (!types.length) {
      el.innerHTML = `
        ${msg}
        <span class="pat-dock-hint muted">${t("pattern.alert.noTypes")}</span>
        <button type="button" class="pat-btn-cancel" id="patPickCancel">${t("pattern.cancel")}</button>
      `;
      $("patPickCancel")?.addEventListener("click", () => {
        patternState.pickMode = false;
        patternState.dockMsg = "";
        renderPatternDock();
      });
      return;
    }
    el.innerHTML = `
      ${msg}
      <label class="pat-pick-label">
        <span class="muted">${t("pattern.pickType")}</span>
        <select class="pat-type-select" id="patPickType">${types
          .map((p) => `<option value="${p.id}">${p.label}</option>`)
          .join("")}</select>
      </label>
      <button type="button" class="pat-btn-capture" id="patStartCase">${t("pattern.startCase")}</button>
      <button type="button" class="pat-btn-cancel" id="patPickCancel">${t("pattern.cancel")}</button>
    `;
    $("patStartCase")?.addEventListener("click", () => {
      const v = $("patPickType")?.value;
      if (v) void createPatternCase(v);
    });
    $("patPickCancel")?.addEventListener("click", () => {
      patternState.pickMode = false;
      patternState.dockMsg = "";
      renderPatternDock();
    });
    return;
  }
  if (!c) {
    el.innerHTML = `
      ${msg}
      <button type="button" class="pat-btn-new" id="patBtnNew">${t("pattern.new")}</button>
    `;
    $("patBtnNew")?.addEventListener("click", () => openPatternTypePicker());
    return;
  }
  const anchor = fmtTime(c.anchor_ts);
  el.innerHTML = `
    ${msg}
    <span class="pat-dock-label">${t("pattern.active")}</span>
    <select class="pat-type-select" id="patDockType" aria-label="${t("pattern.typesTitle")}">${patternTypes()
      .map(
        (p) =>
          `<option value="${p.id}"${p.id === c.pattern_type ? " selected" : ""}>${p.label}</option>`
      )
      .join("")}</select>
    <span class="pat-anchor muted">${t("pattern.anchor")} ${anchor} (${c.primary_tf || state.timeframe})</span>
    <span class="pat-tf-row">${renderPatternTfBadges(c)}</span>
    <label class="pat-dock-outcome">
      <span class="muted">${t("pattern.outcome.label")}</span>
      ${renderPatternOutcomeSelect(c.outcome || "", { id: "patDockOutcome", className: "pat-type-select" })}
    </label>
    <div class="pat-dock-tags">
      <span class="muted">${t("pattern.tagsLabel")}</span>
      ${renderPatternTagPicker(c.tags || [], patternState.tags, { id: "patDockTags" })}
    </div>
    <button type="button" class="pat-btn-capture" id="patBtnCapture">${t("pattern.capture")}</button>
    <button type="button" class="pat-btn-crop" id="patBtnCrop" title="${t("pattern.captureCrop")}">▢</button>
    <button type="button" class="pat-btn-seal" id="patBtnSeal">${t("pattern.seal")}</button>
    <button type="button" class="pat-btn-cancel" id="patBtnCancel">${t("pattern.cancelActive")}</button>
  `;
  $("patDockType")?.addEventListener("change", (e) => {
    const v = e.target.value;
    void updatePatternCase(c.id, {
      pattern_type: v,
      pattern_label: patternTypeLabel(v),
    });
  });
  $("patDockOutcome")?.addEventListener("change", (e) => {
    void updatePatternCase(c.id, { outcome: e.target.value });
  });
  bindPatternTagPicker($("patDockTags"), (tagIds) => {
    void updatePatternCase(c.id, { tags: tagIds });
  });
  $("patBtnCapture")?.addEventListener("click", () => void capturePatternFrame());
  $("patBtnCrop")?.addEventListener("click", () => beginPatternScreenshotPick());
  $("patBtnSeal")?.addEventListener("click", () => void sealPatternCase());
  $("patBtnCancel")?.addEventListener("click", () => {
    patternState.activeCase = null;
    renderPatternDock();
  });
}

function openPatternTypePicker() {
  const types = patternTypes();
  if (!types.length) {
    patternState.pickMode = true;
    patternState.dockMsg = "";
    renderPatternDock();
    return;
  }
  patternState.pickMode = true;
  patternState.dockMsg = "";
  renderPatternDock();
}

async function sealPatternCase() {
  const c = patternState.activeCase;
  if (!c) return;
  await updatePatternCase(c.id, { status: "complete" });
  patternState.activeCase = null;
  renderPatternDock();
}

async function capturePatternFrame(cropRect = null) {
  const c = patternState.activeCase;
  if (!c) {
    openPatternTypePicker();
    return;
  }
  if (!patternApiReady()) {
    patternState.dockMsg = t("pattern.alert.needServer");
    renderPatternDock();
    return;
  }
  if (typeof html2canvas !== "function") {
    patternState.dockMsg = t("alert.screenshotFailed", { msg: "html2canvas" });
    renderPatternDock();
    return;
  }
  pause();
  try {
    let dataUrl;
    if (cropRect) {
      dataUrl = await captureChartAreaDataUrl(cropRect);
    } else {
      const area = chartAreaEl();
      if (!area) throw new Error("chart");
      dataUrl = await captureChartAreaDataUrl({
        left: 0,
        top: 0,
        width: area.offsetWidth,
        height: area.offsetHeight,
      });
    }
    const bar = state.allBars[state.cursor];
    const view = snapshotChartView();
    const result = await uploadPatternFrame(
      c.id,
      state.timeframe,
      dataUrl,
      view,
      bar?.time ?? c.anchor_ts
    );
    patternState.activeCase = result.case;
    patternState.dockMsg = "";
    renderPatternDock();
  } catch (e) {
    console.warn("pattern capture failed", e);
    patternState.dockMsg = t("pattern.alert.captureFailed", { msg: e.message });
    renderPatternDock();
  }
}

function beginPatternScreenshotPick() {
  if (!patternState.activeCase) {
    openPatternTypePicker();
    return;
  }
  if (typeof html2canvas !== "function") {
    patternState.dockMsg = t("alert.screenshotFailed", { msg: "html2canvas" });
    renderPatternDock();
    return;
  }
  pause();
  screenshotPickState.active = true;
  screenshotPickState.orderId = null;
  screenshotPickState.patternMode = true;
  screenshotPickState.dragging = false;
  screenshotPickState.rect = null;
  const { root, hint, bar } = screenshotPickEls();
  if (!root) return;
  root.classList.remove("hidden");
  root.setAttribute("aria-hidden", "false");
  chartAreaEl()?.classList.add("screenshot-picking");
  if (hint) hint.textContent = t("pattern.pickHint");
  bar?.classList.add("hidden");
  applyScreenshotPickBox(null);
}

async function confirmPatternScreenshotPick(rect) {
  await capturePatternFrame(rect);
}

async function restorePatternCase(caseId, preferTf, { setActive = false } = {}) {
  let c = patternState.activeCase;
  if (!c || c.id !== caseId) {
    const cases = await loadPatternCases();
    c = cases.find((x) => x.id === caseId);
  }
  if (!c) return;
  const tf = preferTf || c.primary_tf || "5m";
  const frame = c.frames?.[tf];
  const targetTs = frame?.cursor_ts ?? c.anchor_ts;

  if (setActive) patternState.activeCase = c.status === "draft" ? c : null;

  if (state.timeframe !== tf) {
    await switchTimeframe(tf);
  }
  const idx = findBarIndexByTime(targetTs);
  setCursor(idx, { preserveView: false });
  scrollChartToCursor();

  if (frame?.view) {
    state.tfViews[tf] = frame.view;
    scheduleApplyTimeframeView(frame.view);
  }

  renderPatternDock();
  updateChart({ preserveView: true });
}

async function handlePatternRestoreFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const caseId = params.get("pat_restore");
  if (!caseId) return;
  const tf = params.get("pat_tf") || "5m";
  const setActive = params.get("pat_edit") === "1";
  const clean = new URL(window.location.href);
  clean.searchParams.delete("pat_restore");
  clean.searchParams.delete("pat_tf");
  clean.searchParams.delete("pat_edit");
  window.history.replaceState({}, "", clean.pathname + clean.search);
  await restorePatternCase(caseId, tf, { setActive });
}

async function initPatternJournal() {
  const dock = $("patternDock");
  if (!patternApiReady()) {
    dock?.classList.add("hidden");
    return;
  }
  try {
    await loadPatternTypes();
    await loadPatternTags();
    renderPatternDock();
  } catch (e) {
    console.warn("pattern journal init failed", e);
  }
}

function setupPatternShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (!patternApiReady()) return;
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === "p" || e.key === "P") {
      if (e.shiftKey) {
        e.preventDefault();
        openPatternTypePicker();
      } else if (patternState.activeCase) {
        e.preventDefault();
        void capturePatternFrame();
      }
    }
  });
}
