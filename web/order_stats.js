/**
 * MT5 风格绩效报告：由成交列表计算指标与净值序列。
 * 暴露 window.computeMt5Report / window.formatMt5ReportValue
 */
(function (global) {
  "use strict";

  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function sortRecords(records) {
    return [...(records || [])].sort((a, b) => {
      const ta = num(a.close_ts ?? a.open_ts, 0);
      const tb = num(b.close_ts ?? b.open_ts, 0);
      if (ta !== tb) return ta - tb;
      return num(a.id, 0) - num(b.id, 0);
    });
  }

  function isWin(r) {
    return num(r.net) > 0;
  }

  function isLoss(r) {
    return num(r.net) < 0;
  }

  /** 连续盈/亏段（跳过 net===0 不打断，也不计入段） */
  function buildStreaks(records) {
    const winStreaks = [];
    const lossStreaks = [];
    let cur = null;

    for (const r of records) {
      const net = num(r.net);
      if (net === 0) continue;
      const kind = net > 0 ? "win" : "loss";
      if (!cur || cur.kind !== kind) {
        if (cur) (cur.kind === "win" ? winStreaks : lossStreaks).push(cur);
        cur = { kind, count: 1, sum: net };
      } else {
        cur.count += 1;
        cur.sum += net;
      }
    }
    if (cur) (cur.kind === "win" ? winStreaks : lossStreaks).push(cur);
    return { winStreaks, lossStreaks };
  }

  function avgLength(streaks) {
    if (!streaks.length) return 0;
    return streaks.reduce((s, x) => s + x.count, 0) / streaks.length;
  }

  function maxByCount(streaks) {
    if (!streaks.length) return { count: 0, sum: 0 };
    return streaks.reduce((best, s) => (s.count > best.count ? s : best), streaks[0]);
  }

  function maxByAbsSum(streaks, preferPositive) {
    if (!streaks.length) return { count: 0, sum: 0 };
    return streaks.reduce((best, s) => {
      if (preferPositive) return s.sum > best.sum ? s : best;
      return s.sum < best.sum ? s : best;
    }, streaks[0]);
  }

  function sampleStdev(values) {
    const n = values.length;
    if (n < 2) return null;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const varSum = values.reduce((a, b) => a + (b - mean) ** 2, 0);
    return Math.sqrt(varSum / (n - 1));
  }

  /**
   * @param {Array} records
   * @returns {object|null}
   */
  function computeMt5Report(records) {
    const sorted = sortRecords(records);
    if (!sorted.length) return null;

    const equityCurve = [];
    let equity = 0;
    let peak = 0;
    let maxDd = 0;
    let maxDdPct = 0;
    let maxDdAtPeak = 0;
    let trough = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;
    let largestWin = 0;
    let largestLoss = 0;
    let buyN = 0;
    let buyWins = 0;
    let sellN = 0;
    let sellWins = 0;
    let rrSum = 0;
    let rrCount = 0;
    const tradeReturns = [];
    const daily = new Map();

    sorted.forEach((r, i) => {
      const net = num(r.net);
      equity += net;
      trough = Math.min(trough, equity);
      if (equity > peak) {
        peak = equity;
      }
      const dd = peak - equity;
      if (dd > maxDd) {
        maxDd = dd;
        maxDdAtPeak = peak;
        maxDdPct = peak > 0 ? (100 * dd) / peak : 0;
      }
      equityCurve.push({
        index: i + 1,
        time: num(r.close_ts ?? r.open_ts, i + 1),
        equity,
        net,
        id: r.id,
      });

      if (net > 0) {
        wins += 1;
        grossProfit += net;
        largestWin = Math.max(largestWin, net);
      } else if (net < 0) {
        losses += 1;
        grossLoss += net;
        largestLoss = Math.min(largestLoss, net);
      }

      const dir = String(r.direction || "").toLowerCase();
      if (dir === "buy") {
        buyN += 1;
        if (net > 0) buyWins += 1;
      } else if (dir === "sell") {
        sellN += 1;
        if (net > 0) sellWins += 1;
      }

      tradeReturns.push(net);

      if (r.sl != null && r.tp != null && r.entry != null) {
        const risk = Math.abs(num(r.entry) - num(r.sl));
        const reward = Math.abs(num(r.tp) - num(r.entry));
        if (risk >= 0.01) {
          rrSum += reward / risk;
          rrCount += 1;
        }
      }

      const dayKey =
        typeof global.barDateKey === "function"
          ? global.barDateKey(r.close_ts ?? r.open_ts)
          : String(r.close_time || r.open_time || "").slice(0, 10);
      if (dayKey) daily.set(dayKey, (daily.get(dayKey) || 0) + net);
    });

    const n = sorted.length;
    const totalNet = equity;
    const profitFactor =
      grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? Infinity : 0;
    const expectedPayoff = totalNet / n;
    const recoveryFactor = maxDd > 1e-9 ? totalNet / maxDd : null;
    const meanRet = tradeReturns.reduce((a, b) => a + b, 0) / n;
    const stdev = sampleStdev(tradeReturns);
    const sharpe = stdev != null && stdev > 1e-12 ? meanRet / stdev : null;

    const absDrawdown = trough < 0 ? Math.abs(trough) : 0;
    // 相对结余亏损：相对峰值的最大回撤；另找「相对回撤%最大」时的金额（与 MT5 字段对应）
    let relativeDdPct = maxDdPct;
    let relativeDdAmount = maxDd;
    {
      let p = 0;
      let eq = 0;
      let bestPct = 0;
      let bestAmt = 0;
      for (const r of sorted) {
        eq += num(r.net);
        if (eq > p) p = eq;
        if (p > 0) {
          const amt = p - eq;
          const pct = (100 * amt) / p;
          if (pct > bestPct) {
            bestPct = pct;
            bestAmt = amt;
          }
        }
      }
      relativeDdPct = bestPct;
      relativeDdAmount = bestAmt;
    }

    const { winStreaks, lossStreaks } = buildStreaks(sorted);
    const maxWinStreak = maxByCount(winStreaks);
    const maxLossStreak = maxByCount(lossStreaks);
    const maxConsecProfit = maxByAbsSum(winStreaks, true);
    const maxConsecLoss = maxByAbsSum(lossStreaks, false);

    return {
      totalNet,
      grossProfit,
      grossLoss,
      profitFactor,
      expectedPayoff,
      recoveryFactor,
      sharpe,
      absDrawdown,
      maxDrawdown: maxDd,
      maxDrawdownPct: maxDdPct,
      maxDrawdownAtPeak: maxDdAtPeak,
      relativeDrawdownPct: relativeDdPct,
      relativeDrawdownAmount: relativeDdAmount,
      n,
      wins,
      losses,
      winRate: (100 * wins) / n,
      lossRate: (100 * losses) / n,
      buyN,
      buyWins,
      buyWinRate: buyN ? (100 * buyWins) / buyN : 0,
      sellN,
      sellWins,
      sellWinRate: sellN ? (100 * sellWins) / sellN : 0,
      largestWin,
      largestLoss,
      avgWin: wins ? grossProfit / wins : 0,
      avgLoss: losses ? grossLoss / losses : 0,
      maxConsecWins: maxWinStreak.count,
      maxConsecWinsSum: maxWinStreak.sum,
      maxConsecLosses: maxLossStreak.count,
      maxConsecLossesSum: maxLossStreak.sum,
      maxConsecProfitSum: maxConsecProfit.sum,
      maxConsecProfitCount: maxConsecProfit.count,
      maxConsecLossSum: maxConsecLoss.sum,
      maxConsecLossCount: maxConsecLoss.count,
      avgConsecWins: avgLength(winStreaks),
      avgConsecLosses: avgLength(lossStreaks),
      avgRr: rrCount ? rrSum / rrCount : null,
      maxDd,
      equityCurve,
      daily: [...daily.entries()].sort((a, b) => b[0].localeCompare(a[0])),
    };
  }

  function avgExcursion(records) {
    let mfeSum = 0;
    let maeSum = 0;
    let n = 0;
    for (const r of records || []) {
      const mfe = num(r.max_float_profit, NaN);
      const mae = num(r.max_float_loss, NaN);
      if (!Number.isFinite(mfe) && !Number.isFinite(mae)) continue;
      n += 1;
      mfeSum += Number.isFinite(mfe) ? mfe : 0;
      maeSum += Number.isFinite(mae) ? mae : 0;
    }
    if (!n) return { avgMfe: null, avgMae: null };
    return { avgMfe: mfeSum / n, avgMae: maeSum / n };
  }

  function payoffRatio(report) {
    if (!report) return null;
    const avgWin = num(report.avgWin);
    const avgLoss = num(report.avgLoss);
    if (!(avgWin > 0) || !(avgLoss < 0)) return null;
    return avgWin / Math.abs(avgLoss);
  }

  function enrichTagBucket(tagId, label, records) {
    const report = computeMt5Report(records);
    const { avgMfe, avgMae } = avgExcursion(records);
    return {
      tagId,
      label,
      n: report?.n ?? 0,
      records: records || [],
      report,
      winRate: report?.winRate ?? null,
      totalNet: report?.totalNet ?? null,
      expectedPayoff: report?.expectedPayoff ?? null,
      payoffRatio: payoffRatio(report),
      profitFactor: report?.profitFactor ?? null,
      avgWin: report?.avgWin ?? null,
      avgLoss: report?.avgLoss ?? null,
      avgMfe,
      avgMae,
    };
  }

  /**
   * Per-tag stats. Multi-tag trades count toward each tag.
   * @param {Array} records
   * @param {Array<{id:string,label?:string}>} tagCatalog
   * @returns {{ rows: Array, untagged: object }}
   */
  function computeTagStats(records, tagCatalog) {
    const list = Array.isArray(records) ? records : [];
    const catalog = Array.isArray(tagCatalog) ? tagCatalog : [];
    const byTag = new Map();
    for (const tg of catalog) {
      if (!tg || tg.id == null) continue;
      byTag.set(String(tg.id), []);
    }
    const untagged = [];
    for (const r of list) {
      const tags = Array.isArray(r?.tags)
        ? r.tags.map((x) => String(x ?? "").trim()).filter(Boolean)
        : [];
      if (!tags.length) {
        untagged.push(r);
        continue;
      }
      const seen = new Set();
      for (const id of tags) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (!byTag.has(id)) byTag.set(id, []);
        byTag.get(id).push(r);
      }
    }
    const labelOf = (id) => {
      const found = catalog.find((x) => String(x.id) === String(id));
      return found?.label || String(id);
    };
    const rows = [];
    for (const tg of catalog) {
      const id = String(tg.id);
      rows.push(enrichTagBucket(id, tg.label || id, byTag.get(id) || []));
      byTag.delete(id);
    }
    // orphan tag ids still present on orders
    for (const [id, recs] of byTag) {
      rows.push(enrichTagBucket(id, labelOf(id), recs));
    }
    return {
      rows,
      untagged: enrichTagBucket("__untagged__", "", untagged),
    };
  }

  function formatMt5Number(v, digits = 2) {
    if (v == null || !Number.isFinite(v)) return "—";
    if (v === Infinity) return "∞";
    return v.toFixed(digits);
  }

  global.computeMt5Report = computeMt5Report;
  global.computeTagStats = computeTagStats;
  global.formatMt5Number = formatMt5Number;
})(typeof window !== "undefined" ? window : globalThis);
