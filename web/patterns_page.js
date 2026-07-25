/* 形态管理独立页面 */

function $(id) {
  return document.getElementById(id);
}

const patternPageState = {
  types: [],
  tags: [],
  allCases: [],
  cases: [],
  filterType: "",
  filterStatus: "",
  filterOutcome: "",
  filterTag: "",
  detailCaseId: null,
  detailViewer: null,
  editingTypeId: null,
  typeDraft: "",
  typeNotesEditId: null,
  editingTagId: null,
  tagDraft: "",
};

function showPatternPageError(msg) {
  const title = $("patternPageTitle");
  if (!title) {
    console.warn(msg);
    return;
  }
  title.dataset.errorMsg = msg;
  title.classList.add("pat-page-title-error");
  title.title = msg;
}

function clearPatternPageError() {
  const title = $("patternPageTitle");
  if (!title) return;
  title.classList.remove("pat-page-title-error");
  title.removeAttribute("title");
  delete title.dataset.errorMsg;
}

async function loadPatternPageTypes() {
  const data = await patternFetch("/api/pattern-types");
  patternPageState.types = data.types || [];
}

async function loadPatternPageTags() {
  const data = await patternFetch("/api/pattern-tags");
  patternPageState.tags = data.tags || [];
}

function applyPatternCaseFilters(rows) {
  return rows.filter((c) => {
    if (patternPageState.filterType && c.pattern_type !== patternPageState.filterType) return false;
    if (patternPageState.filterStatus && c.status !== patternPageState.filterStatus) return false;
    const outcome = c.outcome || "";
    if (patternPageState.filterOutcome === "unset") {
      if (outcome) return false;
    } else if (patternPageState.filterOutcome && outcome !== patternPageState.filterOutcome) {
      return false;
    }
    if (patternPageState.filterTag) {
      const tags = c.tags || [];
      if (!tags.includes(patternPageState.filterTag)) return false;
    }
    return true;
  });
}

async function loadPatternPageCases() {
  const data = await patternFetch("/api/patterns");
  patternPageState.allCases = data.cases || [];
  patternPageState.cases = applyPatternCaseFilters(patternPageState.allCases);
}

function patternPageTypeLabel(id) {
  const found = patternPageState.types.find((p) => p.id === id);
  return found?.label || id;
}

function patternPageCaseCount(typeId) {
  return patternPageState.allCases.filter((c) => c.pattern_type === typeId).length;
}

function patternPageTagCaseCount(tagId) {
  return patternPageState.allCases.filter((c) => (c.tags || []).includes(tagId)).length;
}

function resetTypeEditor() {
  patternPageState.editingTypeId = null;
  patternPageState.typeDraft = "";
}

async function savePatternTypeDraft() {
  const label = patternPageState.typeDraft.trim();
  if (!label) return;
  clearPatternPageError();
  const editing = patternPageState.editingTypeId;
  try {
    if (editing && editing !== "new") {
      await patternFetch(`/api/pattern-types/${encodeURIComponent(editing)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
    } else {
      await patternFetch("/api/pattern-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
    }
    resetTypeEditor();
    await loadPatternPageTypes();
    await loadPatternPageCases();
    renderPatternTypesPanel();
    renderPatternTagsPanel();
    renderPatternPageLibrary();
    if (patternPageState.detailCaseId) openPatternPageDetail(patternPageState.detailCaseId);
  } catch (e) {
    showPatternPageError(t("pattern.alert.typeFailed", { msg: e.message }));
  }
}

async function savePatternTypeNotes(typeId, notes) {
  const row = patternPageState.types.find((p) => p.id === typeId);
  if (!row || (row.notes || "") === (notes || "")) return true;
  clearPatternPageError();
  try {
    const updated = await patternFetch(`/api/pattern-types/${encodeURIComponent(typeId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: notes || "" }),
    });
    row.notes = updated.notes || "";
    renderPatternTypesPanel();
    return true;
  } catch (e) {
    showPatternPageError(t("pattern.alert.saveFailed", { msg: e.message }));
    return false;
  }
}

function openPatternTypeNotes(typeId) {
  const row = patternPageState.types.find((p) => p.id === typeId);
  const dlg = $("patternTypeNotes");
  const input = $("patTypeNotesInput");
  const title = $("patTypeNotesTitle");
  if (!row || !dlg || !input) return;
  patternPageState.typeNotesEditId = typeId;
  if (title) title.textContent = `${row.label} · ${t("pattern.typeNotes")}`;
  input.value = row.notes || "";
  input.placeholder = t("pattern.typeNotesPlaceholder");
  dlg.showModal();
  requestAnimationFrame(() => input.focus());
}

async function closePatternTypeNotes({ save = true } = {}) {
  const dlg = $("patternTypeNotes");
  const input = $("patTypeNotesInput");
  const typeId = patternPageState.typeNotesEditId;
  if (!dlg) return;
  if (save && typeId && input) {
    const ok = await savePatternTypeNotes(typeId, input.value);
    if (!ok) return;
  }
  dlg.close();
  patternPageState.typeNotesEditId = null;
}

function setupPatternTypeNotesDialog() {
  const dlg = $("patternTypeNotes");
  if (!dlg || dlg.dataset.bound) return;
  dlg.dataset.bound = "1";
  $("patTypeNotesClose")?.addEventListener("click", () => void closePatternTypeNotes());
  $("patTypeNotesSave")?.addEventListener("click", () => void closePatternTypeNotes());
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    void closePatternTypeNotes();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) void closePatternTypeNotes();
  });
}

function renderPatternTypesPanel() {
  const root = $("patternTypesPanel");
  if (!root) return;
  const types = patternPageState.types;
  const editing = patternPageState.editingTypeId;
  root.innerHTML = `
    <div class="pat-types-head">
      <h2 data-i18n="pattern.typesTitle">${t("pattern.typesTitle")}</h2>
    </div>
    <form class="pat-type-form" id="patTypeForm">
      <input
        type="text"
        id="patTypeInput"
        class="pat-type-input"
        value="${patternPageState.typeDraft.replace(/"/g, "&quot;")}"
        placeholder="${t("pattern.typeCreatePrompt")}"
        autocomplete="off"
      />
      <button type="submit" class="pat-btn-new">${editing && editing !== "new" ? t("pattern.save") : t("pattern.typeNew")}</button>
      ${editing ? `<button type="button" class="pat-btn-cancel" id="patTypeCancel">${t("pattern.cancel")}</button>` : ""}
    </form>
    ${
      types.length
        ? `<ul class="pat-types-list" id="patTypesList">
            ${types
              .map(
                (pt) => `
              <li class="pat-type-row${editing === pt.id ? " pat-type-row-editing" : ""}" data-type-id="${pt.id}">
                <span class="pat-type-label">${pt.label}</span>
                <span class="muted pat-type-count">${t("pattern.typeCaseCount", { n: patternPageCaseCount(pt.id) })}</span>
                <button type="button" class="pat-link pat-type-notes-btn${pt.notes ? " pat-type-has-notes" : ""}" data-type-notes-open="${pt.id}">${t("pattern.typeNotes")}${pt.notes ? " ·" : ""}</button>
                <button type="button" class="pat-link pat-type-edit" data-type-edit="${pt.id}">${t("pattern.typeEdit")}</button>
                <button type="button" class="pat-link pat-del pat-type-del" data-type-del="${pt.id}">${t("pattern.delete")}</button>
              </li>`
              )
              .join("")}
          </ul>`
        : `<p class="pat-empty" data-i18n="pattern.typeEmpty">${t("pattern.typeEmpty")}</p>`
    }
  `;

  const input = $("patTypeInput");
  input?.addEventListener("input", (e) => {
    patternPageState.typeDraft = e.target.value;
  });
  $("patTypeForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    patternPageState.typeDraft = input?.value || "";
    void savePatternTypeDraft();
  });
  $("patTypeCancel")?.addEventListener("click", () => {
    resetTypeEditor();
    renderPatternTypesPanel();
  });
  root.querySelectorAll("[data-type-notes-open]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPatternTypeNotes(btn.dataset.typeNotesOpen);
    });
  });
  root.querySelectorAll("[data-type-edit]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const row = patternPageState.types.find((p) => p.id === btn.dataset.typeEdit);
      if (!row) return;
      patternPageState.editingTypeId = row.id;
      patternPageState.typeDraft = row.label;
      renderPatternTypesPanel();
      input?.focus();
      input?.select();
    });
  });
  root.querySelectorAll("[data-type-del]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void removePatternTypeRow(btn.dataset.typeDel);
    });
  });
  if (editing === "new") input?.focus();
}

async function removePatternTypeRow(typeId) {
  clearPatternPageError();
  try {
    await patternFetch(`/api/pattern-types/${encodeURIComponent(typeId)}`, { method: "DELETE" });
    if (patternPageState.editingTypeId === typeId) resetTypeEditor();
    await loadPatternPageTypes();
    await loadPatternPageCases();
    renderPatternTypesPanel();
    renderPatternTagsPanel();
    renderPatternPageLibrary();
  } catch (e) {
    showPatternPageError(t("pattern.alert.typeFailed", { msg: e.message }));
  }
}

function resetTagEditor() {
  patternPageState.editingTagId = null;
  patternPageState.tagDraft = "";
}

async function savePatternTagDraft() {
  const label = patternPageState.tagDraft.trim();
  if (!label) return;
  clearPatternPageError();
  const editing = patternPageState.editingTagId;
  try {
    if (editing && editing !== "new") {
      await patternFetch(`/api/pattern-tags/${encodeURIComponent(editing)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
    } else {
      await patternFetch("/api/pattern-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
    }
    resetTagEditor();
    await loadPatternPageTags();
    await loadPatternPageCases();
    renderPatternTagsPanel();
    renderPatternPageLibrary();
    if (patternPageState.detailCaseId) openPatternPageDetail(patternPageState.detailCaseId);
  } catch (e) {
    showPatternPageError(t("pattern.alert.tagFailed", { msg: e.message }));
  }
}

async function removePatternTagRow(tagId) {
  clearPatternPageError();
  try {
    await patternFetch(`/api/pattern-tags/${encodeURIComponent(tagId)}`, { method: "DELETE" });
    if (patternPageState.editingTagId === tagId) resetTagEditor();
    if (patternPageState.filterTag === tagId) patternPageState.filterTag = "";
    await loadPatternPageTags();
    await loadPatternPageCases();
    renderPatternTagsPanel();
    renderPatternPageLibrary();
  } catch (e) {
    showPatternPageError(t("pattern.alert.tagFailed", { msg: e.message }));
  }
}

function renderPatternTagsPanel() {
  const root = $("patternTagsPanel");
  if (!root) return;
  const tags = patternPageState.tags;
  const editing = patternPageState.editingTagId;
  root.innerHTML = `
    <div class="pat-types-head">
      <h2 data-i18n="pattern.tagsTitle">${t("pattern.tagsTitle")}</h2>
    </div>
    <form class="pat-type-form" id="patTagForm">
      <input
        type="text"
        id="patTagInput"
        class="pat-type-input"
        value="${patternPageState.tagDraft.replace(/"/g, "&quot;")}"
        placeholder="${t("pattern.tagCreatePrompt")}"
        autocomplete="off"
      />
      <button type="submit" class="pat-btn-new">${editing && editing !== "new" ? t("pattern.save") : t("pattern.tagNew")}</button>
      ${editing ? `<button type="button" class="pat-btn-cancel" id="patTagCancel">${t("pattern.cancel")}</button>` : ""}
    </form>
    ${
      tags.length
        ? `<ul class="pat-types-list" id="patTagsList">
            ${tags
              .map(
                (tg) => `
              <li class="pat-type-row pat-tag-row${editing === tg.id ? " pat-type-row-editing" : ""}" data-tag-id="${tg.id}">
                <span class="pat-tag-badge pat-tag-badge-list">${patternEscapeHtml(tg.label)}</span>
                <span class="muted pat-type-count">${t("pattern.tagCaseCount", { n: patternPageTagCaseCount(tg.id) })}</span>
                <button type="button" class="pat-link pat-type-edit" data-tag-edit="${tg.id}">${t("pattern.typeEdit")}</button>
                <button type="button" class="pat-link pat-del pat-type-del" data-tag-del="${tg.id}">${t("pattern.delete")}</button>
              </li>`
              )
              .join("")}
          </ul>`
        : `<p class="pat-empty">${t("pattern.tagEmpty")}</p>`
    }
  `;

  const input = $("patTagInput");
  input?.addEventListener("input", (e) => {
    patternPageState.tagDraft = e.target.value;
  });
  $("patTagForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    patternPageState.tagDraft = input?.value || "";
    void savePatternTagDraft();
  });
  $("patTagCancel")?.addEventListener("click", () => {
    resetTagEditor();
    renderPatternTagsPanel();
  });
  root.querySelectorAll("[data-tag-edit]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const row = patternPageState.tags.find((p) => p.id === btn.dataset.tagEdit);
      if (!row) return;
      patternPageState.editingTagId = row.id;
      patternPageState.tagDraft = row.label;
      renderPatternTagsPanel();
      input?.focus();
      input?.select();
    });
  });
  root.querySelectorAll("[data-tag-del]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void removePatternTagRow(btn.dataset.tagDel);
    });
  });
  if (editing === "new") input?.focus();
}

function renderPatternPageLibrary() {
  const root = $("patternLibrary");
  if (!root) return;
  const cases = patternPageState.cases;
  root.innerHTML = `
    <div class="pat-lib-toolbar">
      <h2 data-i18n="pattern.casesTitle">${t("pattern.casesTitle")}</h2>
      <select id="patFilterType" class="pat-filter" aria-label="${t("pattern.filter.allTypes")}">
        <option value="">${t("pattern.filter.allTypes")}</option>
        ${patternPageState.types
          .map(
            (p) =>
              `<option value="${p.id}"${patternPageState.filterType === p.id ? " selected" : ""}>${p.label}</option>`
          )
          .join("")}
      </select>
      <select id="patFilterStatus" class="pat-filter" aria-label="${t("pattern.filter.allStatus")}">
        <option value="">${t("pattern.filter.allStatus")}</option>
        <option value="draft"${patternPageState.filterStatus === "draft" ? " selected" : ""}>${t("pattern.status.draft")}</option>
        <option value="complete"${patternPageState.filterStatus === "complete" ? " selected" : ""}>${t("pattern.status.complete")}</option>
      </select>
      ${renderPatternOutcomeFilterSelect(patternPageState.filterOutcome)}
      ${renderPatternTagFilterSelect(patternPageState.filterTag, patternPageState.tags)}
      <span class="muted pat-lib-count">${t("pattern.count", { n: cases.length })}</span>
    </div>
    <div class="pat-card-grid" id="patCardGrid">
      ${
        cases.length
          ? cases.map((c) => renderPatternPageCard(c)).join("")
          : `<p class="pat-empty">${t("pattern.empty")}</p>`
      }
    </div>
  `;

  $("patFilterType")?.addEventListener("change", (e) => {
    patternPageState.filterType = e.target.value;
    patternPageState.cases = applyPatternCaseFilters(patternPageState.allCases);
    renderPatternPageLibrary();
  });
  $("patFilterStatus")?.addEventListener("change", (e) => {
    patternPageState.filterStatus = e.target.value;
    patternPageState.cases = applyPatternCaseFilters(patternPageState.allCases);
    renderPatternPageLibrary();
  });
  $("patFilterOutcome")?.addEventListener("change", (e) => {
    patternPageState.filterOutcome = e.target.value;
    patternPageState.cases = applyPatternCaseFilters(patternPageState.allCases);
    renderPatternPageLibrary();
  });
  $("patFilterTag")?.addEventListener("change", (e) => {
    patternPageState.filterTag = e.target.value;
    patternPageState.cases = applyPatternCaseFilters(patternPageState.allCases);
    renderPatternPageLibrary();
  });

  $("patCardGrid")?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-case-id]");
    if (!card) return;
    if (e.target.closest("[data-pat-delete]")) {
      e.stopPropagation();
      void deletePatternPageCase(card.dataset.caseId);
      return;
    }
    if (e.target.closest("[data-pat-restore]")) {
      e.stopPropagation();
      restorePatternFromPage(card.dataset.caseId);
      return;
    }
    openPatternPageDetail(card.dataset.caseId);
  });
}

function renderPatternPageCard(c) {
  const thumbs = PATTERN_TFS.map((tf) => {
    const fr = c.frames?.[tf];
    if (fr?.screenshot) {
      return `<img src="${patternScreenshotUrl(fr.screenshot)}" class="pat-thumb" alt="${tf}" loading="lazy" />`;
    }
    return `<span class="pat-thumb pat-thumb-empty">${tf}</span>`;
  }).join("");
  const statusCls = c.status === "complete" ? "pat-status-done" : "pat-status-draft";
  const outcome = c.outcome || "";
  const outcomeCls = patternOutcomeBadgeClass(outcome);
  return `
    <article class="pat-card" data-case-id="${c.id}">
      <header class="pat-card-head">
        <span class="pat-card-type">${c.pattern_label || patternPageTypeLabel(c.pattern_type)}</span>
        <span class="pat-card-badges">
          <span class="pat-card-outcome ${outcomeCls}">${patternOutcomeLabel(outcome)}</span>
          <span class="pat-card-status ${statusCls}">${c.status === "complete" ? t("pattern.status.complete") : t("pattern.status.draft")}</span>
        </span>
      </header>
      <div class="pat-card-time">${patternFmtTime(c.anchor_ts)} · ${c.primary_tf || "5m"}</div>
      ${renderPatternTagBadges(c.tags, patternPageState.tags)}
      <div class="pat-card-thumbs">${thumbs}</div>
      <footer class="pat-card-actions">
        <button type="button" class="pat-link" data-pat-restore>${t("pattern.restore")}</button>
        <button type="button" class="pat-link pat-del" data-pat-delete>${t("pattern.delete")}</button>
      </footer>
    </article>
  `;
}

function mergePatternPageCase(updated) {
  if (!updated?.id) return;
  const idx = patternPageState.allCases.findIndex((x) => x.id === updated.id);
  if (idx >= 0) patternPageState.allCases[idx] = updated;
  else patternPageState.allCases.push(updated);
  patternPageState.cases = applyPatternCaseFilters(patternPageState.allCases);
}

async function savePatternCaseField(caseId, patch, { revertEl } = {}) {
  clearPatternPageError();
  const prev =
    revertEl && patch.outcome !== undefined
      ? patternPageState.allCases.find((x) => x.id === caseId)?.outcome || ""
      : null;
  try {
    const updated = await patternFetch(`/api/patterns/${encodeURIComponent(caseId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    mergePatternPageCase(updated);
    renderPatternPageLibrary();
    if (patch.tags) renderPatternTagsPanel();
    return updated;
  } catch (err) {
    if (revertEl && prev !== null) revertEl.value = prev;
    showPatternPageError(t("pattern.alert.saveFailed", { msg: err.message }));
    return null;
  }
}

function openPatternPageDetail(caseId) {
  const c =
    patternPageState.allCases.find((x) => x.id === caseId) ||
    patternPageState.cases.find((x) => x.id === caseId) ||
    null;
  if (!c) return;
  patternPageState.detailCaseId = caseId;
  const dlg = $("patternDetail");
  if (!dlg) return;

  dlg.innerHTML = `
    <div class="pat-detail-inner pat-detail-fullscreen-inner">
      <header class="pat-detail-topbar">
        <div class="pat-detail-topbar-main">
          <h2 class="pat-detail-title">${c.pattern_label || patternPageTypeLabel(c.pattern_type)}</h2>
          <p class="pat-detail-meta muted">${patternFmtTime(c.anchor_ts)} · ${c.primary_tf || "5m"}</p>
          ${renderPatternTagBadges(c.tags, patternPageState.tags, { className: "pat-detail-tag-badges" })}
        </div>
        <div class="pat-detail-topbar-actions">
          <label class="pat-detail-outcome-label">
            <span class="muted">${t("pattern.outcome.label")}</span>
            ${renderPatternOutcomeSelect(c.outcome || "", { id: "patDetailOutcome", className: "pat-detail-outcome-select" })}
          </label>
          <button type="button" class="pat-btn-restore" id="patDetailRestore">${t("pattern.restore")}</button>
          <button type="button" class="pat-btn-edit" id="patDetailEdit">${t("pattern.continueEdit")}</button>
          <button type="button" class="pat-btn-del" id="patDetailDelete">${t("pattern.delete")}</button>
          <button type="button" class="pat-detail-close" id="patDetailClose" aria-label="${t("pattern.close")}">×</button>
        </div>
      </header>
      <label class="pat-detail-notes-label">${t("pattern.notes")}
        <textarea id="patDetailNotes" class="pat-detail-notes" rows="2">${c.notes || ""}</textarea>
      </label>
      <div class="pat-detail-tags-wrap">
        <span class="muted pat-detail-tags-label">${t("pattern.tagsLabel")}</span>
        ${renderPatternTagPicker(c.tags || [], patternPageState.tags, { id: "patDetailTags" })}
      </div>
      <div class="pat-detail-frames-wrap" id="patDetailViewerRoot">
        <h3 class="pat-frames-title">${t("pattern.framesTitle")}</h3>
        ${renderPatternDetailViewer(c)}
      </div>
    </div>
  `;

  patternPageState.detailViewer?.destroy();
  patternPageState.detailViewer = initPatternDetailViewer($("patDetailViewerRoot"), c);

  $("patDetailClose")?.addEventListener("click", closePatternPageDetail);
  $("patDetailRestore")?.addEventListener("click", () => restorePatternFromPage(caseId));
  $("patDetailEdit")?.addEventListener("click", () => {
    window.location.href = patternApiUrl(`/?pat_restore=${encodeURIComponent(caseId)}&pat_tf=${encodeURIComponent(c.primary_tf || "5m")}&pat_edit=1`);
  });
  $("patDetailDelete")?.addEventListener("click", () => void deletePatternPageCase(caseId));
  const outcomeSel = $("patDetailOutcome");
  outcomeSel?.addEventListener("mousedown", (e) => e.stopPropagation());
  outcomeSel?.addEventListener("click", (e) => e.stopPropagation());
  outcomeSel?.addEventListener("change", (e) => {
    e.stopPropagation();
    void savePatternCaseField(caseId, { outcome: e.target.value }, { revertEl: e.target });
  });
  bindPatternTagPicker($("patDetailTags"), (tagIds) => {
    void savePatternCaseField(caseId, { tags: tagIds });
  });
  $("patDetailNotes")?.addEventListener("blur", async (e) => {
    clearPatternPageError();
    try {
      const updated = await patternFetch(`/api/patterns/${encodeURIComponent(caseId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: e.target.value }),
      });
      mergePatternPageCase(updated);
      renderPatternPageLibrary();
    } catch (err) {
      showPatternPageError(t("pattern.alert.saveFailed", { msg: err.message }));
    }
  });

  if (!dlg.open) dlg.showModal();
}

function closePatternPageDetail() {
  patternPageState.detailViewer?.destroy();
  patternPageState.detailViewer = null;
  $("patternDetail")?.close();
  patternPageState.detailCaseId = null;
}

async function deletePatternPageCase(id) {
  clearPatternPageError();
  try {
    await patternFetch(`/api/patterns/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (patternPageState.detailCaseId === id) closePatternPageDetail();
    await loadPatternPageCases();
    renderPatternTypesPanel();
    renderPatternTagsPanel();
    renderPatternPageLibrary();
  } catch (e) {
    showPatternPageError(t("pattern.alert.deleteFailed", { msg: e.message }));
  }
}

function restorePatternFromPage(caseId) {
  const c =
    patternPageState.allCases.find((x) => x.id === caseId) ||
    patternPageState.cases.find((x) => x.id === caseId);
  const tf = c?.primary_tf || "5m";
  window.location.href = patternApiUrl(`/?pat_restore=${encodeURIComponent(caseId)}&pat_tf=${encodeURIComponent(tf)}`);
}

function refreshPatternPageLocale() {
  if (typeof applyI18n === "function") applyI18n();
  renderPatternTypesPanel();
  renderPatternTagsPanel();
  renderPatternPageLibrary();
  if (patternPageState.detailCaseId) openPatternPageDetail(patternPageState.detailCaseId);
  const notesDlg = $("patternTypeNotes");
  if (notesDlg?.open && patternPageState.typeNotesEditId) {
    const row = patternPageState.types.find((p) => p.id === patternPageState.typeNotesEditId);
    const title = $("patTypeNotesTitle");
    if (row && title) title.textContent = `${row.label} · ${t("pattern.typeNotes")}`;
  }
}

async function initPatternManagementPage() {
  initI18n();
  setupPatternFrameZoomDialog();
  setupPatternTypeNotesDialog();
  window.onLocaleChange = refreshPatternPageLocale;

  try {
    const cfgRes = await fetch(patternApiUrl("/api/config"));
    const cfg = await cfgRes.json();
    if (cfg.features?.pattern_journal !== true) {
      $("patternPageMain").innerHTML = `<p class="pat-empty pat-page-inline-msg">${t("pattern.alert.needServer")}</p>`;
      return;
    }
    await loadPatternPageTypes();
    await loadPatternPageTags();
    await loadPatternPageCases();
    renderPatternTypesPanel();
    renderPatternTagsPanel();
    renderPatternPageLibrary();
  } catch (e) {
    console.error(e);
    showPatternPageError(t("pattern.alert.loadFailed", { msg: e.message }));
  }
}

initPatternManagementPage().catch(console.error);
