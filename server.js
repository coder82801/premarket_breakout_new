const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

const ALPACA_API_KEY = process.env.ALPACA_API_KEY || "";
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || "";
const ALPACA_FEED = (process.env.ALPACA_FEED || "iex").toLowerCase();

app.use(express.json());
app.use(express.static(__dirname));

const DEFAULT_SYMBOLS = [
  "ZNTL","RAYA","CUE","FUSE","CREG","SKYQ",
  "SQFT","IPST","TPST","MAXN","GN","SIDU",
  "RBBN","OGN","SPIR","LWLG","AAOI","TTMI","ALAB"
];

function safeNum(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function roundSmart(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (Math.abs(v) < 1) return Number(v.toFixed(4));
  return Number(v.toFixed(2));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function avg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((s, x) => s + safeNum(x, 0), 0) / arr.length;
}

function median(arr) {
  if (!arr || !arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function parseSymbols(raw) {
  const src = String(raw || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(src.length ? src : DEFAULT_SYMBOLS)];
}

function timeZoneParts(date, timeZone = "America/New_York") {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = dtf.formatToParts(date);
  const out = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

function getTimeZoneOffsetMs(date, timeZone = "America/New_York") {
  const parts = timeZoneParts(date, timeZone);
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUTC - date.getTime();
}

function zonedDateTimeToUtcISO(dateStr, timeStr, timeZone = "America/New_York") {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);

  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let i = 0; i < 3; i++) {
    const offset = getTimeZoneOffsetMs(guess, timeZone);
    guess = new Date(guess.getTime() - offset);
  }
  return guess.toISOString();
}

function isoDateNY(iso) {
  const d = new Date(iso);
  const p = timeZoneParts(d, "America/New_York");
  return `${p.year}-${p.month}-${p.day}`;
}

function isoTimeNY(iso) {
  const d = new Date(iso);
  const p = timeZoneParts(d, "America/New_York");
  return `${p.hour}:${p.minute}:${p.second}`;
}

function getTodayNyDate() {
  const p = timeZoneParts(new Date(), "America/New_York");
  return `${p.year}-${p.month}-${p.day}`;
}

function getNowNyTime() {
  const p = timeZoneParts(new Date(), "America/New_York");
  return `${p.hour}:${p.minute}:${p.second}`;
}

function getNySessionNow() {
  const now = new Date();
  const p = timeZoneParts(now, "America/New_York");
  const hh = Number(p.hour);
  const mm = Number(p.minute);
  const mins = hh * 60 + mm;

  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short"
  }).format(now);

  if (weekday === "Sat" || weekday === "Sun") return "weekend";
  if (mins >= 240 && mins < 570) return "premarket";
  if (mins >= 570 && mins < 960) return "open";
  if (mins >= 960 && mins < 1200) return "afterhours";
  return "closed";
}

function decisionRank(decision) {
  if (decision === "GÜÇLÜ AL") return 4;
  if (decision === "AL") return 3;
  if (decision === "İZLE") return 2;
  return 1;
}

async function alpacaGetJson(url) {
  if (!ALPACA_API_KEY || !ALPACA_SECRET_KEY) {
    throw new Error("ALPACA_API_KEY / ALPACA_SECRET_KEY eksik");
  }

  const response = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
      "Accept": "application/json"
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Alpaca ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function fetchAllBars(symbols, timeframe, startISO, endISO, feed = ALPACA_FEED, limit = 10000) {
  const barsBySymbol = {};
  let pageToken = null;

  while (true) {
    const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("start", startISO);
    url.searchParams.set("end", endISO);
    url.searchParams.set("feed", feed);
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("sort", "asc");
    url.searchParams.set("limit", String(limit));
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const json = await alpacaGetJson(url.toString());
    const bars = json.bars || {};

    for (const [symbol, arr] of Object.entries(bars)) {
      if (!barsBySymbol[symbol]) barsBySymbol[symbol] = [];
      barsBySymbol[symbol].push(...arr);
    }

    if (!json.next_page_token) break;
    pageToken = json.next_page_token;
  }

  for (const symbol of symbols) {
    if (!barsBySymbol[symbol]) barsBySymbol[symbol] = [];
    barsBySymbol[symbol].sort((a, b) => new Date(a.t) - new Date(b.t));
  }

  return barsBySymbol;
}

function computeCloseStrength(bar) {
  if (!bar) return null;

  const high = safeNum(bar.h, null);
  const low = safeNum(bar.l, null);
  const close = safeNum(bar.c, null);

  if ([high, low, close].some((v) => v == null)) return null;

  const range = high - low;
  if (range <= 0) return 50;

  return ((close - low) / range) * 100;
}

function computeRangePctFromValues(high, low, ref) {
  high = safeNum(high, null);
  low = safeNum(low, null);
  ref = safeNum(ref, null);
  if ([high, low, ref].some((v) => v == null) || ref <= 0) return null;
  return ((high - low) / ref) * 100;
}

function computeVWAP(bars) {
  if (!bars || !bars.length) return null;
  let pv = 0;
  let vv = 0;

  for (const b of bars) {
    const h = safeNum(b.h, 0);
    const l = safeNum(b.l, 0);
    const c = safeNum(b.c, 0);
    const v = safeNum(b.v, 0);
    const tp = (h + l + c) / 3;
    pv += tp * v;
    vv += v;
  }

  if (vv <= 0) return null;
  return pv / vv;
}

function getBarsForDate(allBars, dateStr) {
  return (allBars || []).filter((b) => isoDateNY(b.t) === dateStr);
}

function filterBarsByTime(bars, startTime, endTime) {
  return (bars || []).filter((b) => {
    const t = isoTimeNY(b.t);
    return t >= startTime && t <= endTime;
  });
}

function getPreviousTradingContext(dailyBars, tradeDate) {
  const sorted = [...(dailyBars || [])].sort((a, b) => new Date(a.t) - new Date(b.t));
  const priorBars = sorted.filter((b) => isoDateNY(b.t) < tradeDate);

  if (priorBars.length < 3) return null;

  const last = priorBars[priorBars.length - 1];
  const prev = priorBars[priorBars.length - 2];
  const histWindow = priorBars.slice(Math.max(0, priorBars.length - 21), priorBars.length - 1);
  const priorDates = [...new Set(priorBars.map((b) => isoDateNY(b.t)))].slice(-10);

  return {
    lastCompleted: last,
    previous: prev,
    histWindow,
    priorDates
  };
}

function buildNightlyMetricsFromDaily(lastCompleted, previous, histWindow) {
  const prevClose = safeNum(lastCompleted.c, 0);
  const prevHigh = safeNum(lastCompleted.h, 0);
  const prevLow = safeNum(lastCompleted.l, 0);
  const prevVol = safeNum(lastCompleted.v, 0);
  const prevDollarVol = prevClose * prevVol;
  const prevCloseStrength = computeCloseStrength(lastCompleted);

  const priorClose = safeNum(previous.c, 0);
  const prevDayRet =
    priorClose > 0 ? ((prevClose - priorClose) / priorClose) * 100 : 0;

  const avgPrevVol = Math.max(avg((histWindow || []).map((b) => safeNum(b.v, 0))), 1);
  const prevVolRatio = prevVol / avgPrevVol;
  const prevRangePct = computeRangePctFromValues(prevHigh, prevLow, prevClose);

  return {
    prevClose,
    prevHigh,
    prevLow,
    prevVol,
    prevDollarVol,
    prevCloseStrength,
    prevDayRet,
    prevVolRatio,
    prevRangePct
  };
}

function scoreNightly(metrics) {
  let score = 0;
  const notes = [];

  const price = safeNum(metrics.prevClose, 0);
  const ret = safeNum(metrics.prevDayRet, 0);
  const closeStrength = safeNum(metrics.prevCloseStrength, 0);
  const volRatio = safeNum(metrics.prevVolRatio, 0);
  const dollarVol = safeNum(metrics.prevDollarVol, 0);
  const rangePct = safeNum(metrics.prevRangePct, 999);

  if (price >= 0.2 && price <= 8) score += 10;
  else if (price > 8 && price <= 20) score += 5;
  else if (price < 0.2) {
    score -= 10;
    notes.push("Aşırı düşük fiyat");
  }

  if (ret >= 4 && ret < 12) score += 12;
  else if (ret >= 12 && ret < 35) score += 18;
  else if (ret >= 35 && ret < 80) score += 10;
  else if (ret > 100) {
    score -= 6;
    notes.push("Önceki gün aşırı uzama");
  } else if (ret < 0) {
    score -= 10;
  }

  if (closeStrength >= 85) score += 18;
  else if (closeStrength >= 72) score += 10;
  else if (closeStrength < 45) {
    score -= 10;
    notes.push("Zayıf kapanış");
  }

  if (volRatio >= 1.2 && volRatio < 2.5) score += 10;
  else if (volRatio >= 2.5 && volRatio < 6) score += 16;
  else if (volRatio >= 6) score += 18;
  else if (volRatio < 0.8) score -= 8;

  if (dollarVol >= 100000 && dollarVol < 500000) score += 8;
  else if (dollarVol >= 500000 && dollarVol < 3000000) score += 14;
  else if (dollarVol >= 3000000) score += 16;
  else if (dollarVol < 50000) {
    score -= 10;
    notes.push("Dollar volume zayıf");
  }

  if (rangePct <= 12) score += 4;
  else if (rangePct > 50) {
    score -= 4;
    notes.push("Range çok geniş");
  }

  score = clamp(Math.round(score), 0, 100);
  return { score, notes };
}

function computeCumulativePremarketVolumeForDate(minuteBars, dateStr, cutoffTime = "09:25:00") {
  const dayBars = getBarsForDate(minuteBars, dateStr);
  const preBars = filterBarsByTime(dayBars, "04:00:00", cutoffTime);
  return preBars.reduce((sum, b) => sum + safeNum(b.v, 0), 0);
}

function computeSameTimePremarketBaseline(minuteBars, priorDates, cutoffTime = "09:25:00") {
  const vols = [];
  for (const d of priorDates || []) {
    const v = computeCumulativePremarketVolumeForDate(minuteBars, d, cutoffTime);
    if (v > 0) vols.push(v);
  }

  return {
    baselineMedian: vols.length ? median(vols) : 0,
    baselineAvg: vols.length ? avg(vols) : 0,
    samples: vols.length
  };
}

function buildPremarketContext(minuteBars, tradeDate, cutoffTime = "09:25:00") {
  const dayBars = getBarsForDate(minuteBars, tradeDate);
  const preBars = filterBarsByTime(dayBars, "04:00:00", cutoffTime);

  if (!preBars.length) {
    return {
      source: "NONE",
      preLast: null,
      preHigh: null,
      preLow: null,
      preVol: 0,
      preVWAP: null,
      holdQuality: null,
      preRangePct: null,
      barCount: 0
    };
  }

  const preLast = safeNum(preBars[preBars.length - 1].c, null);
  const preHigh = Math.max(...preBars.map((b) => safeNum(b.h, 0)));
  const preLow = Math.min(...preBars.map((b) => safeNum(b.l, 0)));
  const preVol = preBars.reduce((s, b) => s + safeNum(b.v, 0), 0);
  const preVWAP = computeVWAP(preBars);
  const holdQuality =
    preHigh > preLow ? ((preLast - preLow) / (preHigh - preLow)) * 100 : 50;
  const preRangePct = computeRangePctFromValues(preHigh, preLow, preLast);

  return {
    source: "REAL_PREMARKET",
    preLast,
    preHigh,
    preLow,
    preVol,
    preVWAP,
    holdQuality,
    preRangePct,
    barCount: preBars.length
  };
}

function scorePremarket(pre) {
  let score = 0;
  const notes = [];

  const feed = pre.feed;
  const price = safeNum(pre.price, 0);
  const gapPct = safeNum(pre.gapPct, 0);
  const preVolRatio = safeNum(pre.preVolRatio, 0);
  const holdQuality = safeNum(pre.holdQuality, 0);
  const preRangePct = safeNum(pre.preRangePct, 999);
  const preDollarVol = safeNum(pre.preDollarVol, 0);
  const abovePreVWAP = !!pre.abovePreVWAP;
  const abovePrevHigh = !!pre.abovePrevHigh;
  const source = pre.source || "NONE";

  if (source !== "REAL_PREMARKET") {
    notes.push("Gerçek premarket verisi yok");
    return { score: 0, notes };
  }

  if (feed === "sip") score += 4;
  else notes.push("IEX feed");

  if (price >= 0.2 && price <= 8) score += 6;
  else if (price > 8 && price <= 20) score += 3;
  else if (price < 0.2) score -= 8;

  if (gapPct >= 1 && gapPct < 4) score += 6;
  else if (gapPct >= 4 && gapPct < 15) score += 16;
  else if (gapPct >= 15 && gapPct < 35) score += 20;
  else if (gapPct >= 35 && gapPct < 80) {
    score += 12;
    notes.push("Aşırı sıcak gap");
  } else if (gapPct < 0) {
    score -= 12;
  }

  if (preVolRatio >= 0.8 && preVolRatio < 1.5) score += 10;
  else if (preVolRatio >= 1.5 && preVolRatio < 3) score += 18;
  else if (preVolRatio >= 3) {
    score += 26;
    notes.push("Hacim anomalisi güçlü");
  } else if (preVolRatio < 0.5) {
    score -= 10;
  }

  if (preDollarVol >= 100000 && preDollarVol < 400000) score += 10;
  else if (preDollarVol >= 400000 && preDollarVol < 1500000) score += 16;
  else if (preDollarVol >= 1500000) score += 20;
  else if (preDollarVol < 75000) {
    score -= 12;
    notes.push("Premarket dollar volume zayıf");
  }

  if (holdQuality >= 85) score += 18;
  else if (holdQuality >= 72) score += 12;
  else if (holdQuality >= 60) score += 6;
  else if (holdQuality < 45) {
    score -= 12;
    notes.push("Premarket hold zayıf");
  }

  if (abovePreVWAP) score += 12;
  else {
    score -= 12;
    notes.push("Premarket VWAP altında");
  }

  if (abovePrevHigh) {
    score += 10;
    notes.push("Previous day high üstünde");
  }

  if (preRangePct <= 20) score += 4;
  else if (preRangePct > 50) {
    score -= 8;
    notes.push("Premarket range aşırı geniş");
  }

  if (
    price <= 5 &&
    gapPct >= 12 &&
    holdQuality >= 70 &&
    preDollarVol >= 200000 &&
    abovePreVWAP
  ) {
    score += 10;
    notes.push("Microcap catalyst uyumu");
  }

  if (
    feed === "iex" &&
    preVolRatio < 0.8 &&
    preDollarVol >= 350000 &&
    holdQuality >= 82 &&
    abovePreVWAP
  ) {
    score += 8;
    notes.push("IEX hacim toleransı");
  }

  score = clamp(Math.round(score), 0, 100);
  return { score, notes };
}

function decideLiteRow({ nightlyScore, premarketScore, source, holdQuality, abovePreVWAP, preDollarVol }) {
  if (source !== "REAL_PREMARKET") {
    if (nightlyScore >= 68) return "İZLE";
    return "ALMA";
  }

  const hardReject =
    !abovePreVWAP ||
    safeNum(holdQuality, 0) < 50 ||
    safeNum(preDollarVol, 0) < 75000;

  if (hardReject) return "ALMA";

  if (
    nightlyScore >= 58 &&
    premarketScore >= 76 &&
    holdQuality >= 72
  ) {
    return "GÜÇLÜ AL";
  }

  if (
    nightlyScore >= 48 &&
    premarketScore >= 62 &&
    holdQuality >= 60
  ) {
    return "AL";
  }

  if (nightlyScore >= 68) return "İZLE";
  return "ALMA";
}

function buildBacktestRow(symbol, feed, dailyBars, minuteBars, tradeDate) {
  const ctx = getPreviousTradingContext(dailyBars, tradeDate);
  if (!ctx) return null;

  const nightlyMetrics = buildNightlyMetricsFromDaily(
    ctx.lastCompleted,
    ctx.previous,
    ctx.histWindow
  );

  const nightly = scoreNightly(nightlyMetrics);
  const preCtx = buildPremarketContext(minuteBars, tradeDate, "09:25:00");
  const baseline = computeSameTimePremarketBaseline(minuteBars, ctx.priorDates, "09:25:00");

  const price = preCtx.preLast;
  const gapPct =
    price != null && nightlyMetrics.prevClose > 0
      ? ((price - nightlyMetrics.prevClose) / nightlyMetrics.prevClose) * 100
      : null;

  const preVolRatio =
    preCtx.preVol > 0 && baseline.baselineMedian > 0
      ? preCtx.preVol / baseline.baselineMedian
      : 0;

  const preDollarVol =
    price != null && preCtx.preVol > 0 ? price * preCtx.preVol : 0;

  const abovePreVWAP =
    preCtx.preVWAP != null && price != null ? price > preCtx.preVWAP : false;

  const abovePrevHigh =
    price != null && nightlyMetrics.prevHigh > 0 ? price > nightlyMetrics.prevHigh : false;

  const premarket = scorePremarket({
    feed,
    source: preCtx.source,
    price,
    gapPct,
    preVolRatio,
    holdQuality: preCtx.holdQuality,
    preRangePct: preCtx.preRangePct,
    preDollarVol,
    abovePreVWAP,
    abovePrevHigh
  });

  const decision = decideLiteRow({
    nightlyScore: nightly.score,
    premarketScore: premarket.score,
    source: preCtx.source,
    holdQuality: preCtx.holdQuality,
    abovePreVWAP,
    preDollarVol
  });

  return {
    symbol,
    source: preCtx.source,
    decision,
    nightlyScore: nightly.score,
    premarketScore: premarket.score,
    totalScore: Math.max(nightly.score, premarket.score),

    price: roundSmart(price),
    prevClose: roundSmart(nightlyMetrics.prevClose),
    prevHigh: roundSmart(nightlyMetrics.prevHigh),
    gapPct: roundSmart(gapPct),

    preVol: Math.round(preCtx.preVol),
    preVolBaselineMedian: Math.round(baseline.baselineMedian),
    preVolRatio: roundSmart(preVolRatio),
    preDollarVol: Math.round(preDollarVol),

    preVWAP: roundSmart(preCtx.preVWAP),
    abovePreVWAP,
    holdQuality: roundSmart(preCtx.holdQuality),
    preRangePct: roundSmart(preCtx.preRangePct),

    prevDayRet: roundSmart(nightlyMetrics.prevDayRet),
    prevCloseStrength: roundSmart(nightlyMetrics.prevCloseStrength),
    prevVolRatio: roundSmart(nightlyMetrics.prevVolRatio),
    prevDollarVol: Math.round(nightlyMetrics.prevDollarVol),

    notes: [...nightly.notes, ...premarket.notes].join(" | ")
  };
}

function buildNightlyOnlyRow(symbol, dailyBars) {
  const sorted = [...(dailyBars || [])].sort((a, b) => new Date(a.t) - new Date(b.t));
  if (sorted.length < 3) return null;

  const lastCompleted = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2];
  const histWindow = sorted.slice(Math.max(0, sorted.length - 22), sorted.length - 1);

  const nightlyMetrics = buildNightlyMetricsFromDaily(lastCompleted, previous, histWindow);
  const nightly = scoreNightly(nightlyMetrics);

  const decision = nightly.score >= 68 ? "İZLE" : "ALMA";

  return {
    symbol,
    source: "NONE",
    decision,
    nightlyScore: nightly.score,
    premarketScore: 0,
    totalScore: nightly.score,

    price: null,
    prevClose: roundSmart(nightlyMetrics.prevClose),
    prevHigh: roundSmart(nightlyMetrics.prevHigh),
    gapPct: null,

    preVol: 0,
    preVolBaselineMedian: 0,
    preVolRatio: 0,
    preDollarVol: 0,

    preVWAP: null,
    abovePreVWAP: false,
    holdQuality: null,
    preRangePct: null,

    prevDayRet: roundSmart(nightlyMetrics.prevDayRet),
    prevCloseStrength: roundSmart(nightlyMetrics.prevCloseStrength),
    prevVolRatio: roundSmart(nightlyMetrics.prevVolRatio),
    prevDollarVol: Math.round(nightlyMetrics.prevDollarVol),

    notes: nightly.notes.join(" | ")
  };
}

function buildBacktestOutcome(tradeDayMinuteBars, tradeDate, preLast) {
  const dayBars = getBarsForDate(tradeDayMinuteBars, tradeDate);
  const openBars = filterBarsByTime(dayBars, "09:30:00", "10:00:00");
  if (!openBars.length) {
    return {
      realizedPremarketTo30HighPct: null,
      realizedOpenTo30HighPct: null
    };
  }

  const open = safeNum(openBars[0].o, null);
  const high30 = Math.max(...openBars.map((b) => safeNum(b.h, 0)));

  const realizedPremarketTo30HighPct =
    preLast != null && preLast > 0 ? ((high30 - preLast) / preLast) * 100 : null;

  const realizedOpenTo30HighPct =
    open != null && open > 0 ? ((high30 - open) / open) * 100 : null;

  return {
    realizedPremarketTo30HighPct: roundSmart(realizedPremarketTo30HighPct),
    realizedOpenTo30HighPct: roundSmart(realizedOpenTo30HighPct)
  };
}

function summarizeRows(rows) {
  const picks = rows.filter((r) => r.decision === "GÜÇLÜ AL" || r.decision === "AL").slice(0, 3);
  const vals = picks
    .map((r) => safeNum(r.realizedPremarketTo30HighPct, null))
    .filter((v) => v != null);

  return {
    total: rows.length,
    strong: rows.filter((r) => r.decision === "GÜÇLÜ AL").length,
    buy: rows.filter((r) => r.decision === "AL").length,
    watch: rows.filter((r) => r.decision === "İZLE").length,
    topPicks: picks.length,
    avgPremarketTo30: vals.length ? roundSmart(avg(vals)) : null,
    hit10: vals.filter((v) => v >= 10).length,
    hit15: vals.filter((v) => v >= 15).length
  };
}

async function buildBacktest(dateStr, symbols) {
  const lookbackStart = new Date(new Date(dateStr).getTime() - 12 * 86400000);

  const dailyStart = zonedDateTimeToUtcISO(
    lookbackStart.toISOString().slice(0, 10),
    "00:00"
  );
  const dailyEnd = zonedDateTimeToUtcISO(dateStr, "23:59");

  const priorMinuteStart = zonedDateTimeToUtcISO(
    lookbackStart.toISOString().slice(0, 10),
    "04:00"
  );
  const priorMinuteEnd = zonedDateTimeToUtcISO(dateStr, "03:59");

  const tradeMinuteStart = zonedDateTimeToUtcISO(dateStr, "04:00");
  const tradeMinuteEnd = zonedDateTimeToUtcISO(dateStr, "10:00");

  const [dailyBarsMap, prior5MinMap, trade1MinMap] = await Promise.all([
    fetchAllBars(symbols, "1Day", dailyStart, dailyEnd, ALPACA_FEED, 10000),
    fetchAllBars(symbols, "5Min", priorMinuteStart, priorMinuteEnd, ALPACA_FEED, 10000),
    fetchAllBars(symbols, "1Min", tradeMinuteStart, tradeMinuteEnd, ALPACA_FEED, 10000)
  ]);

  const rows = [];

  for (const symbol of symbols) {
    const dailyBars = dailyBarsMap[symbol] || [];
    const prior5 = prior5MinMap[symbol] || [];
    const trade1 = trade1MinMap[symbol] || [];
    const mergedMinuteBars = [...prior5, ...trade1].sort((a, b) => new Date(a.t) - new Date(b.t));

    const row = buildBacktestRow(symbol, ALPACA_FEED, dailyBars, mergedMinuteBars, dateStr);
    if (!row) continue;

    const outcome = buildBacktestOutcome(trade1, dateStr, row.price);

    rows.push({
      ...row,
      realizedPremarketTo30HighPct: outcome.realizedPremarketTo30HighPct,
      realizedOpenTo30HighPct: outcome.realizedOpenTo30HighPct
    });
  }

  rows.sort((a, b) => {
    const aKey =
      decisionRank(a.decision) * 100000 +
      safeNum(a.premarketScore, 0) * 100 +
      safeNum(a.nightlyScore, 0);

    const bKey =
      decisionRank(b.decision) * 100000 +
      safeNum(b.premarketScore, 0) * 100 +
      safeNum(b.nightlyScore, 0);

    return bKey - aKey;
  });

  return {
    mode: "BACKTEST_FULL",
    tradeDate: dateStr,
    session: "backtest",
    feed: ALPACA_FEED,
    cutoffTime: "09:25:00",
    rows,
    summary: summarizeRows(rows)
  };
}

async function buildLive(symbols) {
  const session = getNySessionNow();
  const today = getTodayNyDate();
  const nowNy = getNowNyTime();

  if (session === "weekend") {
    return {
      mode: "NO_MARKET",
      session,
      feed: ALPACA_FEED,
      cutoffTime: null,
      rows: [],
      summary: { total: 0, strong: 0, buy: 0, watch: 0, topPicks: 0, avgPremarketTo30: null, hit10: 0, hit15: 0 },
      message: "Hafta sonu."
    };
  }

  const lookbackStart = new Date(Date.now() - 12 * 86400000);
  const lookbackDateStr = lookbackStart.toISOString().slice(0, 10);

  const dailyStart = zonedDateTimeToUtcISO(lookbackDateStr, "00:00");
  const dailyEnd = new Date().toISOString();

  // After-hours ve closed için sadece nightly shortlist
  if (session === "afterhours" || session === "closed") {
    const dailyBarsMap = await fetchAllBars(symbols, "1Day", dailyStart, dailyEnd, ALPACA_FEED, 10000);
    const rows = [];

    for (const symbol of symbols) {
      const row = buildNightlyOnlyRow(symbol, dailyBarsMap[symbol] || []);
      if (!row) continue;
      rows.push(row);
    }

    rows.sort((a, b) => {
      const aKey = decisionRank(a.decision) * 100000 + safeNum(a.nightlyScore, 0);
      const bKey = decisionRank(b.decision) * 100000 + safeNum(b.nightlyScore, 0);
      return bKey - aKey;
    });

    return {
      mode: "NIGHTLY_ONLY",
      session,
      feed: ALPACA_FEED,
      cutoffTime: null,
      rows,
      summary: summarizeRows(rows),
      message: session === "afterhours"
        ? "After-hours modunda sadece nightly shortlist üretilir."
        : "Piyasa kapalı. Sadece nightly shortlist üretilir."
    };
  }

  if (nowNy < "04:00:00") {
    return {
      mode: "NO_PREMARKET_YET",
      session,
      feed: ALPACA_FEED,
      cutoffTime: null,
      rows: [],
      summary: { total: 0, strong: 0, buy: 0, watch: 0, topPicks: 0, avgPremarketTo30: null, hit10: 0, hit15: 0 },
      message: "Premarket henüz başlamadı. 04:00 ET sonrası tekrar dene."
    };
  }

  let cutoffTime = "09:25:00";
  if (session === "premarket") {
    cutoffTime = nowNy > "09:25:00" ? "09:25:00" : nowNy;
  } else if (session === "open") {
    cutoffTime = "09:25:00";
  }

  const priorMinuteStart = zonedDateTimeToUtcISO(lookbackDateStr, "04:00");
  const priorMinuteEnd = zonedDateTimeToUtcISO(today, "03:59");

  const tradeMinuteStart = zonedDateTimeToUtcISO(today, "04:00");
  const tradeMinuteEnd = new Date().toISOString();

  const priorStartMs = new Date(priorMinuteStart).getTime();
  const priorEndMs = new Date(priorMinuteEnd).getTime();
  const tradeStartMs = new Date(tradeMinuteStart).getTime();
  const tradeEndMs = new Date(tradeMinuteEnd).getTime();

  if (!(tradeEndMs > tradeStartMs)) {
    return {
      mode: "WAITING_WINDOW",
      session,
      feed: ALPACA_FEED,
      cutoffTime,
      rows: [],
      summary: { total: 0, strong: 0, buy: 0, watch: 0, topPicks: 0, avgPremarketTo30: null, hit10: 0, hit15: 0 },
      message: "Trade minute penceresi henüz oluşmadı."
    };
  }

  let prior5MinMap = {};
  for (const s of symbols) prior5MinMap[s] = [];

  const [dailyBarsMap, trade1MinMap] = await Promise.all([
    fetchAllBars(symbols, "1Day", dailyStart, dailyEnd, ALPACA_FEED, 10000),
    fetchAllBars(symbols, "1Min", tradeMinuteStart, tradeMinuteEnd, ALPACA_FEED, 10000)
  ]);

  if (priorEndMs > priorStartMs) {
    prior5MinMap = await fetchAllBars(
      symbols,
      "5Min",
      priorMinuteStart,
      priorMinuteEnd,
      ALPACA_FEED,
      10000
    );
  }

  const rows = [];

  for (const symbol of symbols) {
    const dailyBars = dailyBarsMap[symbol] || [];
    const prior5 = prior5MinMap[symbol] || [];
    const trade1 = trade1MinMap[symbol] || [];
    const mergedMinuteBars = [...prior5, ...trade1].sort((a, b) => new Date(a.t) - new Date(b.t));

    const row = buildBacktestRow(symbol, ALPACA_FEED, dailyBars, mergedMinuteBars, today);
    if (!row) continue;
    rows.push(row);
  }

  rows.sort((a, b) => {
    const aKey =
      decisionRank(a.decision) * 100000 +
      safeNum(a.premarketScore, 0) * 100 +
      safeNum(a.nightlyScore, 0);

    const bKey =
      decisionRank(b.decision) * 100000 +
      safeNum(b.premarketScore, 0) * 100 +
      safeNum(b.nightlyScore, 0);

    return bKey - aKey;
  });

  return {
    mode: "PREMARKET_CONFIRM",
    session,
    feed: ALPACA_FEED,
    cutoffTime,
    rows,
    summary: summarizeRows(rows),
    message: null
  };
}

app.get("/test", (req, res) => {
  res.json({ status: "SERVER OK" });
});

app.get("/api/default-symbols", (req, res) => {
  res.json({ symbols: DEFAULT_SYMBOLS });
});

app.get("/api/live-lite", async (req, res) => {
  try {
    const symbols = parseSymbols(req.query.symbols);
    const data = await buildLive(symbols);
    res.json(data);
  } catch (err) {
    console.error("LIVE_LITE error:", err);
    res.status(500).json({ error: "server error", detail: err.message });
  }
});

app.get("/api/backtest-lite", async (req, res) => {
  try {
    const dateStr = String(req.query.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: "date parametresi YYYY-MM-DD formatında olmalı" });
    }

    const symbols = parseSymbols(req.query.symbols);
    const data = await buildBacktest(dateStr, symbols);
    res.json(data);
  } catch (err) {
    console.error("BACKTEST_LITE error:", err);
    res.status(500).json({ error: "server error", detail: err.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((req, res) => {
  res.status(404).send(`Route not found: ${req.method} ${req.originalUrl}`);
});

app.listen(PORT, () => {
  console.log(`Breakout Lite Engine running on port ${PORT}`);
});
