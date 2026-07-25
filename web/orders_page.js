/* 独立订单管理页：/orders.html — 标签统计 + 可编辑明细 */

(function () {
  "use strict";

  const UNTAGGED_ID = "__untagged__";
  const AND_COMBOS_KEY = "orders_tag_and_combos_v1";
  const TEXT_FIELDS = ["entry_reason", "tp_reason", "sl_reason", "notes"];

  /** @type {Array} */
  let allRecords = [];
  let nextOrderId = 1;
  /** @type {Array<{id:string,label?:string}>} */
  let tagCatalog = [];
  /** @type {string|null} */
  let activeTagId = null;
  /** @type {string[]} currently selected AND tag ids */
  let andTagIds = [];
  /** @type {Array<{id:string,tagIds:string[],label:string}>} */
  let savedAndCombos = [];
  /** @type {{ key: string, dir: "asc" | "desc" }} */
  let tagSort = { key: "n", dir: "desc" };
  let saveTimer = null;
  let saveMsgTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function apiUrl(path) {
    const base = typeof window.__API_BASE__ === "string" ? window.__API_BASE__ : "";
    return `${base}${path}`;
  }

  function escAttr(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function fmtSigned(v, digits = 2) {
    if (v == null || !Number.isFinite(v)) return "—";
    const s = Math.abs(v).toFixed(digits);
    if (v > 0) return `+${s}`;
    if (v < 0) return `-${s}`;
    return (0).toFixed(digits);
  }

  function fNum(v, digits = 2) {
    if (typeof formatMt5Number === "function") return formatMt5Number(v, digits);
    if (v == null || !Number.isFinite(v)) return "—";
    if (v === Infinity) return "∞";
    return v.toFixed(digits);
  }

  function pct(v) {
    return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
  }

  function pnlClass(v) {
    if (v == null || !Number.isFinite(v) || v === 0) return "";
    return v > 0 ? "pnl-pos" : "pnl-neg";
  }

  function tDir(dir) {
    const d = String(dir || "").toLowerCase();
    if (d === "buy") return typeof t === "function" ? t("dir.buy") : "buy";
    if (d === "sell") return typeof t === "function" ? t("dir.sell") : "sell";
    return d || "—";
  }

  function tExit(reason) {
    if (reason === "sl") return typeof t === "function" ? t("exit.sl") : "sl";
    if (reason === "tp") return typeof t === "function" ? t("exit.tp") : "tp";
    if (reason === "manual") return typeof t === "function" ? t("exit.manual") : "manual";
    return reason || "—";
  }

  function recordTs(r) {
    const n = Number(r?.close_ts ?? r?.open_ts);
    return Number.isFinite(n) ? n : null;
  }

  function tsToDateKey(ts) {
    if (ts == null) return "";
    if (typeof dateKeyInDisplayTz === "function") return dateKeyInDisplayTz(ts);
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }

  function dateKeyToStartTs(dateStr) {
    if (!dateStr) return null;
    if (typeof dateKeyToStartTsInDisplayTz === "function") {
      return dateKeyToStartTsInDisplayTz(dateStr);
    }
    const ms = Date.parse(`${dateStr}T00:00:00+08:00`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  function dateKeyToEndTs(dateStr) {
    if (!dateStr) return null;
    if (typeof dateKeyToEndTsInDisplayTz === "function") {
      return dateKeyToEndTsInDisplayTz(dateStr);
    }
    const ms = Date.parse(`${dateStr}T23:59:59.999+08:00`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  function normalizeTags(tags) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(tags) ? tags : []) {
      const id = String(raw ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function normalizeRecord(rec) {
    if (!rec) return rec;
    rec.entry_reason = String(rec.entry_reason ?? "");
    rec.tp_reason = String(rec.tp_reason ?? "");
    rec.sl_reason = String(rec.sl_reason ?? "");
    rec.notes = String(rec.notes ?? "");
    rec.tags = normalizeTags(rec.tags);
    return rec;
  }

  function tagLabel(id) {
    if (id === UNTAGGED_ID) return t("ordersPage.untagged");
    const found = tagCatalog.find((x) => String(x.id) === String(id));
    return found?.label || String(id);
  }

  function showEmpty(on) {
    $("ordersEmpty")?.classList.toggle("hidden", !on);
    $("ordersContent")?.classList.toggle("hidden", on);
  }

  function setSaveMsg(msg, isError) {
    const el = $("ordersSaveMsg");
    if (!el) return;
    clearTimeout(saveMsgTimer);
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.classList.toggle("pnl-neg", !!isError);
    el.classList.toggle("pnl-pos", !isError);
    saveMsgTimer = setTimeout(() => {
      el.hidden = true;
    }, 2500);
  }

  async function persistOrders() {
    const payload = {
      version: 1,
      orderRecords: allRecords,
      nextOrderId,
    };
    const res = await fetch(apiUrl("/api/orders"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
    }
    const store = await res.json();
    if (typeof store.nextOrderId === "number") nextOrderId = store.nextOrderId;
    setSaveMsg(t("ordersPage.saved"));
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void persistOrders().catch((e) => {
        console.warn("save orders failed", e);
        setSaveMsg(e?.message || t("ordersPage.saveFailed"), true);
      });
    }, 400);
  }

  function filterByDate(records) {
    const fromEl = $("ordersDateFrom");
    const toEl = $("ordersDateTo");
    const fromTs = dateKeyToStartTs(fromEl?.value || "");
    const toTs = dateKeyToEndTs(toEl?.value || "");
    return (records || []).filter((r) => {
      const ts = recordTs(r);
      if (ts == null) return false;
      if (fromTs != null && ts < fromTs) return false;
      if (toTs != null && ts > toTs) return false;
      return true;
    });
  }

  function normalizeAndIds(ids) {
    if (typeof normalizeAndTagIds === "function") return normalizeAndTagIds(ids);
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw ?? "").trim();
      if (!id || id.startsWith("__") || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    out.sort();
    return out;
  }

  function andKeyFromIds(ids) {
    if (typeof makeAndTagKey === "function") return makeAndTagKey(ids);
    const sorted = normalizeAndIds(ids);
    return sorted.length >= 2 ? `__and__:${sorted.join(",")}` : null;
  }

  function andIdsFromKey(key) {
    if (typeof parseAndTagKey === "function") return parseAndTagKey(key);
    const s = String(key || "");
    if (!s.startsWith("__and__:")) return null;
    return normalizeAndIds(s.slice("__and__:".length).split(","));
  }

  function isAndTagId(tagId) {
    return !!andIdsFromKey(tagId);
  }

  function loadSavedAndCombos() {
    try {
      const raw = localStorage.getItem(AND_COMBOS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      savedAndCombos = Array.isArray(parsed)
        ? parsed
            .map((c) => {
              const tagIds = normalizeAndIds(c?.tagIds);
              if (tagIds.length < 2) return null;
              return {
                id: String(c?.id || andKeyFromIds(tagIds)),
                tagIds,
                label: String(c?.label || tagIds.map(tagLabel).join(" ∩ ")),
              };
            })
            .filter(Boolean)
        : [];
    } catch {
      savedAndCombos = [];
    }
  }

  function persistSavedAndCombos() {
    try {
      localStorage.setItem(AND_COMBOS_KEY, JSON.stringify(savedAndCombos));
    } catch (e) {
      console.warn("save AND combos failed", e);
    }
  }

  function filterByTag(records, tagId) {
    if (!tagId) return records;
    if (tagId === UNTAGGED_ID) {
      return records.filter((r) => !normalizeTags(r.tags).length);
    }
    const andIds = andIdsFromKey(tagId);
    if (andIds && andIds.length >= 2) {
      if (typeof recordsMatchingAllTags === "function") {
        return recordsMatchingAllTags(records, andIds);
      }
      return records.filter((r) => {
        const set = new Set(normalizeTags(r.tags));
        return andIds.every((id) => set.has(id));
      });
    }
    return records.filter((r) => normalizeTags(r.tags).includes(tagId));
  }

  function dateFilteredRecords() {
    return filterByDate(allRecords).map((r) => normalizeRecord(r));
  }

  function visibleRecords() {
    return filterByTag(dateFilteredRecords(), activeTagId);
  }

  function syncFilterBounds() {
    const filter = $("ordersFilter");
    if (!allRecords.length) {
      if (filter) filter.hidden = true;
      return;
    }
    if (filter) filter.hidden = false;
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const r of allRecords) {
      const ts = recordTs(r);
      if (ts == null) continue;
      minTs = Math.min(minTs, ts);
      maxTs = Math.max(maxTs, ts);
    }
    if (!Number.isFinite(minTs)) return;
    const minKey = tsToDateKey(minTs);
    const maxKey = tsToDateKey(maxTs);
    const fromEl = $("ordersDateFrom");
    const toEl = $("ordersDateTo");
    if (fromEl) {
      fromEl.min = minKey;
      fromEl.max = maxKey;
      if (!fromEl.value) fromEl.value = minKey;
    }
    if (toEl) {
      toEl.min = minKey;
      toEl.max = maxKey;
      if (!toEl.value) toEl.value = maxKey;
    }
  }

  function updateFilterCount() {
    const el = $("ordersFilterCount");
    if (!el) return;
    const n = visibleRecords().length;
    const total = allRecords.length;
    el.textContent = t("report.filterCount", { n, total });
    const clearBtn = $("ordersTagFilterClear");
    if (clearBtn) clearBtn.hidden = !activeTagId;
  }

  function sortValue(row, key) {
    if (key === "label") {
      if (row.tagId === UNTAGGED_ID) return t("ordersPage.untagged");
      return String(row.label || tagLabel(row.tagId) || "");
    }
    const v = row[key];
    if (v == null || !Number.isFinite(Number(v))) return null;
    const n = Number(v);
    return n === Infinity ? Number.MAX_VALUE : n;
  }

  function compareTagRows(a, b) {
    const key = tagSort.key;
    const dir = tagSort.dir === "asc" ? 1 : -1;
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // empty metrics sink
    if (vb == null) return -1;
    if (typeof va === "string" || typeof vb === "string") {
      return dir * String(va).localeCompare(String(vb), undefined, { sensitivity: "base" });
    }
    if (va !== vb) return dir * (va < vb ? -1 : 1);
    // stable tie-break: more trades first, then label
    const na = a.n || 0;
    const nb = b.n || 0;
    if (na !== nb) return nb - na;
    return String(a.label || a.tagId).localeCompare(String(b.label || b.tagId));
  }

  function syncTagSortHeaders() {
    document.querySelectorAll("#ordersTagStatsTable th.orders-sort-th").forEach((th) => {
      const key = th.dataset.sort;
      const active = key === tagSort.key;
      th.classList.toggle("sort-active", active);
      th.classList.toggle("sort-asc", active && tagSort.dir === "asc");
      th.classList.toggle("sort-desc", active && tagSort.dir === "desc");
      th.setAttribute("aria-sort", active ? (tagSort.dir === "asc" ? "ascending" : "descending") : "none");
    });
  }

  function setTagSort(key) {
    if (!key) return;
    if (tagSort.key === key) {
      tagSort.dir = tagSort.dir === "asc" ? "desc" : "asc";
    } else {
      tagSort.key = key;
      tagSort.dir = key === "label" ? "asc" : "desc";
    }
    renderTagStats();
  }

  function renderAndBar() {
    const chipsEl = $("ordersAndChips");
    if (chipsEl) {
      chipsEl.innerHTML = "";
      if (!tagCatalog.length) {
        chipsEl.innerHTML = `<span class="muted orders-and-empty">${escAttr(t("ordersPage.and.noTags"))}</span>`;
      } else {
        const selected = new Set(andTagIds);
        for (const tg of tagCatalog) {
          const id = String(tg.id);
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "orders-and-chip" + (selected.has(id) ? " active" : "");
          btn.dataset.tagId = id;
          btn.textContent = tg.label || id;
          btn.setAttribute("aria-pressed", selected.has(id) ? "true" : "false");
          chipsEl.appendChild(btn);
        }
      }
    }

    const savedWrap = $("ordersAndSaved");
    const savedList = $("ordersAndSavedList");
    if (savedList) {
      savedList.innerHTML = "";
      for (const combo of savedAndCombos) {
        const wrap = document.createElement("span");
        wrap.className = "orders-and-saved-item";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "orders-and-saved-btn";
        btn.dataset.comboId = combo.id;
        btn.textContent = combo.label;
        btn.title = combo.tagIds.map(tagLabel).join(" ∩ ");
        const del = document.createElement("button");
        del.type = "button";
        del.className = "orders-and-saved-del";
        del.dataset.comboId = combo.id;
        del.setAttribute("aria-label", t("ordersPage.and.removeSaved"));
        del.textContent = "×";
        wrap.appendChild(btn);
        wrap.appendChild(del);
        savedList.appendChild(wrap);
      }
    }
    if (savedWrap) savedWrap.hidden = !savedAndCombos.length;
  }

  function toggleAndChip(tagId) {
    const id = String(tagId ?? "").trim();
    if (!id) return;
    const set = new Set(andTagIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    andTagIds = normalizeAndIds([...set]);
    renderAndBar();
  }

  function applyAndCombo() {
    const ids = normalizeAndIds(andTagIds);
    if (ids.length < 2) {
      setSaveMsg(t("ordersPage.and.needTwo"), true);
      return;
    }
    andTagIds = ids;
    activeTagId = andKeyFromIds(ids);
    renderAll();
    $("ordersListTable")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function clearAndCombo() {
    andTagIds = [];
    if (isAndTagId(activeTagId)) activeTagId = null;
    renderAll();
  }

  function saveCurrentAndCombo() {
    const ids = normalizeAndIds(andTagIds);
    if (ids.length < 2) {
      setSaveMsg(t("ordersPage.and.needTwo"), true);
      return;
    }
    const key = andKeyFromIds(ids);
    const label = ids.map(tagLabel).join(" ∩ ");
    const existing = savedAndCombos.findIndex((c) => c.id === key);
    const entry = { id: key, tagIds: ids, label };
    if (existing >= 0) savedAndCombos[existing] = entry;
    else savedAndCombos.push(entry);
    persistSavedAndCombos();
    renderAndBar();
    setSaveMsg(t("ordersPage.and.comboSaved"));
  }

  function loadAndCombo(comboId) {
    const combo = savedAndCombos.find((c) => c.id === comboId);
    if (!combo) return;
    andTagIds = normalizeAndIds(combo.tagIds);
    activeTagId = andKeyFromIds(andTagIds);
    renderAll();
    $("ordersListTable")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function removeSavedAndCombo(comboId) {
    savedAndCombos = savedAndCombos.filter((c) => c.id !== comboId);
    persistSavedAndCombos();
    renderAndBar();
  }

  function renderTagStats() {
    const body = $("ordersTagStatsBody");
    if (!body) return;
    body.innerHTML = "";
    const dated = dateFilteredRecords();
    const stats =
      typeof computeTagStats === "function"
        ? computeTagStats(dated, tagCatalog)
        : { rows: [], untagged: { tagId: UNTAGGED_ID, n: 0 } };

    const rows = [...(stats.rows || []), stats.untagged].filter(Boolean);
    rows.sort(compareTagRows);
    syncTagSortHeaders();

    const andIds = normalizeAndIds(andTagIds);
    let andRow = null;
    if (andIds.length >= 2) {
      andRow =
        typeof computeTagAndStats === "function"
          ? computeTagAndStats(dated, andIds, tagCatalog)
          : null;
      if (andRow) {
        const tr = document.createElement("tr");
        tr.dataset.tagId = andRow.tagId;
        tr.classList.add("orders-and-row");
        if (activeTagId === andRow.tagId) tr.classList.add("active");
        const empty = !(andRow.n > 0);
        const label = andRow.label || andIds.map(tagLabel).join(" ∩ ");
        tr.innerHTML = `
        <td><span class="orders-and-row-label">${escAttr(label)}</span></td>
        <td>${empty ? "0" : String(andRow.n)}</td>
        <td>${empty ? "—" : pct(andRow.winRate)}</td>
        <td class="${pnlClass(andRow.totalNet)}">${empty ? "—" : fmtSigned(andRow.totalNet)}</td>
        <td class="${pnlClass(andRow.expectedPayoff)}">${empty ? "—" : fmtSigned(andRow.expectedPayoff)}</td>
        <td>${empty ? "—" : fNum(andRow.payoffRatio)}</td>
        <td>${empty ? "—" : fNum(andRow.profitFactor)}</td>
        <td class="pnl-pos">${empty ? "—" : fmtSigned(andRow.avgWin)}</td>
        <td class="pnl-neg">${empty ? "—" : fmtSigned(andRow.avgLoss)}</td>
        <td class="pnl-pos">${empty ? "—" : fNum(andRow.avgMfe)}</td>
        <td class="pnl-neg">${empty ? "—" : fNum(andRow.avgMae)}</td>
      `;
        body.appendChild(tr);
      }
    }

    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.dataset.tagId = row.tagId;
      if (activeTagId === row.tagId) tr.classList.add("active");
      const empty = !(row.n > 0);
      const label = row.tagId === UNTAGGED_ID ? t("ordersPage.untagged") : row.label || tagLabel(row.tagId);
      tr.innerHTML = `
        <td>${escAttr(label)}</td>
        <td>${empty ? "0" : String(row.n)}</td>
        <td>${empty ? "—" : pct(row.winRate)}</td>
        <td class="${pnlClass(row.totalNet)}">${empty ? "—" : fmtSigned(row.totalNet)}</td>
        <td class="${pnlClass(row.expectedPayoff)}">${empty ? "—" : fmtSigned(row.expectedPayoff)}</td>
        <td>${empty ? "—" : fNum(row.payoffRatio)}</td>
        <td>${empty ? "—" : fNum(row.profitFactor)}</td>
        <td class="pnl-pos">${empty ? "—" : fmtSigned(row.avgWin)}</td>
        <td class="pnl-neg">${empty ? "—" : fmtSigned(row.avgLoss)}</td>
        <td class="pnl-pos">${empty ? "—" : fNum(row.avgMfe)}</td>
        <td class="pnl-neg">${empty ? "—" : fNum(row.avgMae)}</td>
      `;
      body.appendChild(tr);
    }
  }

  function renderAll() {
    if (!allRecords.length) {
      showEmpty(true);
      updateFilterCount();
      return;
    }
    showEmpty(false);
    renderAndBar();
    renderTagStats();
    renderOrderList();
    updateFilterCount();
  }

  function setActiveTag(tagId) {
    if (isAndTagId(tagId)) {
      const ids = andIdsFromKey(tagId) || [];
      andTagIds = normalizeAndIds(ids);
      if (activeTagId === tagId) activeTagId = null;
      else activeTagId = tagId;
    } else {
      // single-tag / untagged: exit AND mode
      andTagIds = [];
      if (activeTagId === tagId) activeTagId = null;
      else activeTagId = tagId;
    }
    renderAll();
    $("ordersListTable")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function formatTagsSummary(tags) {
    const list = normalizeTags(tags);
    if (!list.length) return t("table.tags.none");
    return list.map(tagLabel).join(", ");
  }

  function renderTagsCell(rec) {
    const selected = new Set(normalizeTags(rec.tags));
    if (!tagCatalog.length) {
      return `<div class="stmt-tags-empty muted">${t("table.tags.empty")} <a href="/patterns.html" class="stmt-tags-manage">${t("table.tags.manage")}</a></div>`;
    }
    const options = tagCatalog
      .map((tg) => {
        const checked = selected.has(tg.id) ? " checked" : "";
        return `<label class="stmt-tag-option">
      <input type="checkbox" data-action="order-tag" data-id="${escAttr(String(rec.id))}" data-tag="${escAttr(tg.id)}"${checked} />
      <span>${escAttr(tg.label || tg.id)}</span>
    </label>`;
      })
      .join("");
    return `<details class="stmt-tags" data-order-id="${escAttr(String(rec.id))}">
    <summary class="stmt-tags-summary">${escAttr(formatTagsSummary(rec.tags))}</summary>
    <div class="stmt-tags-menu" role="group">${options}</div>
  </details>`;
  }

  function renderOrderList() {
    const body = $("ordersListBody");
    if (!body) return;
    body.innerHTML = "";
    const list = visibleRecords().slice().sort((a, b) => {
      const tb = Number(b.open_ts ?? b.close_ts ?? 0);
      const ta = Number(a.open_ts ?? a.close_ts ?? 0);
      return tb - ta;
    });
    if (!list.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="15" class="orders-list-empty">${t(
        activeTagId ? "ordersPage.filterEmpty" : "ordersPage.empty"
      )}</td>`;
      body.appendChild(tr);
      return;
    }
    for (const r of list) {
      normalizeRecord(r);
      const tr = document.createElement("tr");
      tr.dataset.id = String(r.id);
      const pnlCls = pnlClass(r.net);
      const dirCls = r.direction === "buy" ? "buy" : "sell";
      const exitCls = r.exit === "sl" ? "tag-sl" : r.exit === "tp" ? "tag-tp" : "";
      const entry = r.entry != null && Number.isFinite(r.entry) ? r.entry.toFixed(2) : "—";
      const lots =
        r.lots != null && Number.isFinite(Number(r.lots)) ? String(r.lots) : "—";
      tr.innerHTML = `
        <td>${escAttr(String(r.id))}</td>
        <td>${escAttr(
          r.open_ts != null && typeof fmtDisplayTime === "function"
            ? fmtDisplayTime(r.open_ts)
            : r.open_time || "—"
        )}</td>
        <td>${escAttr(
          r.close_ts != null && typeof fmtDisplayTime === "function"
            ? fmtDisplayTime(r.close_ts)
            : r.close_time || "—"
        )}</td>
        <td class="${dirCls}">${tDir(r.direction)}</td>
        <td class="stmt-readonly">${escAttr(lots)}</td>
        <td class="stmt-readonly">${entry}</td>
        <td><input type="text" class="stmt-input stmt-text" data-field="entry_reason" data-id="${escAttr(String(r.id))}" value="${escAttr(r.entry_reason)}" placeholder="${escAttr(t("table.reason.placeholder"))}" /></td>
        <td><input type="text" class="stmt-input stmt-text" data-field="tp_reason" data-id="${escAttr(String(r.id))}" value="${escAttr(r.tp_reason)}" placeholder="${escAttr(t("table.reason.placeholder"))}" /></td>
        <td><input type="text" class="stmt-input stmt-text" data-field="sl_reason" data-id="${escAttr(String(r.id))}" value="${escAttr(r.sl_reason)}" placeholder="${escAttr(t("table.reason.placeholder"))}" /></td>
        <td class="stmt-tags-cell">${renderTagsCell(r)}</td>
        <td class="${pnlCls}">${fmtSigned(r.net ?? 0)}</td>
        <td class="${exitCls}">${tExit(r.exit)}</td>
        <td><input type="text" class="stmt-input stmt-text stmt-notes" data-field="notes" data-id="${escAttr(String(r.id))}" value="${escAttr(r.notes)}" placeholder="${escAttr(t("table.notes.placeholder"))}" /></td>
        <td><a class="orders-chart-link" href="/?focusOrder=${encodeURIComponent(String(r.id))}" data-i18n-skip="1">${t("ordersPage.openChart")}</a></td>
        <td class="stmt-actions">
          <button type="button" class="btn-order-del" data-action="delete" data-id="${escAttr(String(r.id))}" title="${escAttr(t("orders.delete.title"))}">×</button>
        </td>
      `;
      body.appendChild(tr);
    }
  }

  function findRecord(id) {
    return allRecords.find((r) => String(r.id) === String(id));
  }

  function updateField(id, field, value) {
    const rec = findRecord(id);
    if (!rec || !TEXT_FIELDS.includes(field)) return;
    rec[field] = String(value ?? "").trim();
    normalizeRecord(rec);
    scheduleSave();
  }

  function toggleTag(id, tagId, on) {
    const rec = findRecord(id);
    const tid = String(tagId ?? "").trim();
    if (!rec || !tid) return;
    const catalogIds = new Set(tagCatalog.map((x) => x.id));
    if (on && !catalogIds.has(tid)) return;
    const set = new Set(normalizeTags(rec.tags));
    if (on) set.add(tid);
    else set.delete(tid);
    const ordered = [];
    for (const tg of tagCatalog) {
      if (set.has(tg.id)) ordered.push(tg.id);
    }
    for (const x of set) {
      if (!ordered.includes(x)) ordered.push(x);
    }
    rec.tags = ordered;
    normalizeRecord(rec);
    const details = document.querySelector(
      `details.stmt-tags[data-order-id="${CSS.escape(String(id))}"]`
    );
    if (details) {
      const summary = details.querySelector(".stmt-tags-summary");
      if (summary) summary.textContent = formatTagsSummary(rec.tags);
    }
    scheduleSave();
    renderTagStats();
    updateFilterCount();
  }

  function deleteRecord(id) {
    if (!confirm(t("confirm.deleteOrder", { id }))) return;
    allRecords = allRecords.filter((r) => String(r.id) !== String(id));
    renderAll();
    scheduleSave();
  }

  function positionTagMenu(details) {
    const menu = details.querySelector(".stmt-tags-menu");
    if (!menu) return;
    if (!details.open) {
      menu.classList.remove("stmt-tags-menu-fixed", "stmt-tags-menu-up");
      menu.style.left = "";
      menu.style.top = "";
      menu.style.maxHeight = "";
      return;
    }
    document.querySelectorAll("details.stmt-tags[open]").forEach((d) => {
      if (d !== details) d.open = false;
    });
    const rect = details.querySelector(".stmt-tags-summary")?.getBoundingClientRect();
    if (!rect) return;
    const gap = 4;
    const edge = 8;
    const preferMax = 240;
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - gap - edge);
    const spaceAbove = Math.max(0, rect.top - gap - edge);
    const openUp = spaceBelow < 140 && spaceAbove > spaceBelow;
    const avail = openUp ? spaceAbove : spaceBelow;
    const maxH = Math.max(96, Math.min(preferMax, avail));
    menu.classList.add("stmt-tags-menu-fixed");
    menu.classList.toggle("stmt-tags-menu-up", openUp);
    menu.style.left = `${Math.round(rect.left)}px`;
    menu.style.maxHeight = `${Math.round(maxH)}px`;
    menu.style.top = openUp
      ? `${Math.round(rect.top - gap - maxH)}px`
      : `${Math.round(rect.bottom + gap)}px`;
  }

  function bindEvents() {
    $("ordersDateFrom")?.addEventListener("change", () => {
      const fromEl = $("ordersDateFrom");
      const toEl = $("ordersDateTo");
      if (fromEl && toEl && fromEl.value && toEl.value && fromEl.value > toEl.value) {
        const tmp = fromEl.value;
        fromEl.value = toEl.value;
        toEl.value = tmp;
      }
      renderAll();
    });
    $("ordersDateTo")?.addEventListener("change", () => {
      const fromEl = $("ordersDateFrom");
      const toEl = $("ordersDateTo");
      if (fromEl && toEl && fromEl.value && toEl.value && fromEl.value > toEl.value) {
        const tmp = fromEl.value;
        fromEl.value = toEl.value;
        toEl.value = tmp;
      }
      renderAll();
    });
    $("ordersFilterReset")?.addEventListener("click", () => {
      syncFilterBounds();
      const fromEl = $("ordersDateFrom");
      const toEl = $("ordersDateTo");
      if (fromEl) fromEl.value = fromEl.min || "";
      if (toEl) toEl.value = toEl.max || "";
      activeTagId = null;
      andTagIds = [];
      renderAll();
    });
    $("ordersTagFilterClear")?.addEventListener("click", () => {
      activeTagId = null;
      renderAll();
    });

    $("ordersAndChips")?.addEventListener("click", (e) => {
      const chip = e.target.closest("button.orders-and-chip[data-tag-id]");
      if (!chip) return;
      toggleAndChip(chip.dataset.tagId);
    });
    $("ordersAndApply")?.addEventListener("click", () => applyAndCombo());
    $("ordersAndSave")?.addEventListener("click", () => saveCurrentAndCombo());
    $("ordersAndClear")?.addEventListener("click", () => clearAndCombo());
    $("ordersAndSavedList")?.addEventListener("click", (e) => {
      const del = e.target.closest("button.orders-and-saved-del[data-combo-id]");
      if (del) {
        e.preventDefault();
        removeSavedAndCombo(del.dataset.comboId);
        return;
      }
      const btn = e.target.closest("button.orders-and-saved-btn[data-combo-id]");
      if (btn) loadAndCombo(btn.dataset.comboId);
    });

    $("ordersTagStatsTable")?.querySelector("thead")?.addEventListener("click", (e) => {
      const th = e.target.closest("th.orders-sort-th[data-sort]");
      if (!th) return;
      e.preventDefault();
      setTagSort(th.dataset.sort);
    });

    $("ordersTagStatsBody")?.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-tag-id]");
      if (!tr) return;
      setActiveTag(tr.dataset.tagId);
    });

    const listBody = $("ordersListBody");
    listBody?.addEventListener("change", (e) => {
      const tagCb = e.target.closest("input[data-action='order-tag']");
      if (tagCb) {
        toggleTag(tagCb.dataset.id, tagCb.dataset.tag, tagCb.checked);
        return;
      }
      const el = e.target.closest("[data-field]");
      if (!el) return;
      updateField(el.dataset.id, el.dataset.field, el.value);
    });
    listBody?.addEventListener(
      "blur",
      (e) => {
        const el = e.target.closest("input.stmt-text[data-field]");
        if (!el) return;
        updateField(el.dataset.id, el.dataset.field, el.value);
      },
      true
    );
    listBody?.addEventListener("click", (e) => {
      const del = e.target.closest("[data-action='delete']");
      if (del) {
        e.preventDefault();
        deleteRecord(del.dataset.id);
        return;
      }
      if (e.target.closest(".stmt-tags")) return;
    });
    listBody?.addEventListener(
      "toggle",
      (e) => {
        const details = e.target;
        if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("stmt-tags")) {
          return;
        }
        positionTagMenu(details);
      },
      true
    );
    listBody?.addEventListener(
      "wheel",
      (e) => {
        if (!e.target.closest(".stmt-tags-menu")) return;
        e.stopPropagation();
      },
      { passive: true }
    );
    document.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".stmt-tags")) return;
      document.querySelectorAll("details.stmt-tags[open]").forEach((d) => {
        d.open = false;
      });
    });
  }

  async function loadData() {
    const [ordersRes, tagsRes] = await Promise.all([
      fetch(apiUrl("/api/orders")),
      fetch(apiUrl("/api/pattern-tags")),
    ]);
    if (!ordersRes.ok) throw new Error(ordersRes.statusText || `HTTP ${ordersRes.status}`);
    const store = await ordersRes.json();
    allRecords = Array.isArray(store.orderRecords)
      ? store.orderRecords.map((r) => normalizeRecord({ ...r }))
      : [];
    nextOrderId =
      typeof store.nextOrderId === "number" && store.nextOrderId > 0
        ? store.nextOrderId
        : allRecords.length + 1;

    if (tagsRes.ok) {
      const tagData = await tagsRes.json();
      tagCatalog = Array.isArray(tagData.tags) ? tagData.tags : [];
    } else {
      tagCatalog = [];
    }
  }

  window.onLocaleChange = function () {
    if (typeof applyI18n === "function") applyI18n();
    renderAll();
  };

  async function init() {
    if (typeof initI18n === "function") initI18n();
    document.documentElement.dataset.i18nTitle = "ordersPage.pageTitle";
    if (typeof applyI18n === "function") applyI18n();
    loadSavedAndCombos();
    bindEvents();
    try {
      await loadData();
      syncFilterBounds();
      renderAll();
    } catch (e) {
      console.warn("load orders page failed", e);
      allRecords = [];
      showEmpty(true);
      const empty = $("ordersEmpty");
      if (empty) empty.textContent = e?.message || t("ordersPage.empty");
    }
  }

  init();
})();
