/* 独立订单管理页：/orders.html — 标签统计 + 可编辑明细 */

(function () {
  "use strict";

  const UNTAGGED_ID = "__untagged__";
  const TEXT_FIELDS = ["entry_reason", "tp_reason", "sl_reason", "notes"];

  /** @type {Array} */
  let allRecords = [];
  let nextOrderId = 1;
  /** @type {Array<{id:string,label?:string}>} */
  let tagCatalog = [];
  /** @type {string|null} */
  let activeTagId = null;
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
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }

  function dateKeyToStartTs(dateStr) {
    if (!dateStr) return null;
    const ms = Date.parse(`${dateStr}T00:00:00.000Z`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  function dateKeyToEndTs(dateStr) {
    if (!dateStr) return null;
    const ms = Date.parse(`${dateStr}T23:59:59.999Z`);
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

  function filterByTag(records, tagId) {
    if (!tagId) return records;
    if (tagId === UNTAGGED_ID) {
      return records.filter((r) => !normalizeTags(r.tags).length);
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
        <td>${escAttr(r.open_time || "—")}</td>
        <td>${escAttr(r.close_time || "—")}</td>
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

  function renderAll() {
    if (!allRecords.length) {
      showEmpty(true);
      updateFilterCount();
      return;
    }
    showEmpty(false);
    renderTagStats();
    renderOrderList();
    updateFilterCount();
  }

  function setActiveTag(tagId) {
    if (activeTagId === tagId) activeTagId = null;
    else activeTagId = tagId;
    renderAll();
    $("ordersListTable")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      renderAll();
    });
    $("ordersTagFilterClear")?.addEventListener("click", () => {
      activeTagId = null;
      renderAll();
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
