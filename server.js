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
  "SQFT","IPST","TPST","MAXN","GN","SIDU"
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

function getSessionLabelNow() {
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
  if (decision === "GÜÇLÜ AL") return 3;
  if (decision === "AL") return 2;
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

async function fetchSnapshots(symbols, feed = ALPACA_FEED) {
  const url = new URL("https://data.alpaca.markets/v2/stocks/snapshots");
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("feed", feed);
  return alpacaGetJson(url.toString());
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

function getDailyContext(dailyBars, tradeDate) {
  const sorted = [...(dailyBars || [])].sort((a, b) => new Date(a.t) - new Date(b.t));
  const priorBars = sorted.filter((b) => isoDateNY(b.t) < tradeDate);

  if (priorBars.length < 2) return null;

  const prevBar = priorBars[priorBars.length - 1];
  const prev2Bar = priorBars[priorBars.length - 2];

  const priorDates = [...new Set(priorBars.map((b) => isoDateNY(b.t)))].slice(-20);

  return {
    prevBar,
    prev2Bar,
    priorDates
  };
}

function computeCumulativePremarketVolumeForDate(minuteBars, dateStr, cutoffTime = "09:25:00") {
  const dayBars = getBarsForDate(minuteBars, dateStr);
  const preBars = filterBarsByTime(dayBars, "04:00:00", cutoffTime);
  return preBars.reduce((sum, b) => sum + safeNum(b.v, 0), 0);
}

function computeSameTimePremarketBaseline(minuteBars, priorDates, cutoffTime = "09:25:00") {
  const vols = [];
  for (const d of priorDates) {
    const v = computeCumulativePremarketVolumeForDate(minuteBars, d, cutoffTime);
    if (v > 0) vols.push(v);
  }
  return {
    baselineMedian: vols.length ? median(vols) : 0,
    baselineAvg: vols.length ? avg(vols) : 0,
    samples: vols.length
  };
}

function buildPremarketContextForDate(minuteBars, dateStr, cutoffTime = "09:25:00") {
  const dayBars = getBarsForDate(minuteBars, dateStr);
  const preBars = filterBarsByTime(dayBars, "04:00:00", cutoffTime);

  if (!preBars.length) {
    return {
      hasRealPremarket: false,
      source: "NONE",
      preLast: null,
      preHigh: null,
      preLow: null,
      preVol: 0,
      preVWAP: null,
      holdQuality: null,
      rangePct: null,
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
  const rangePct = computeRangePctFromValues(preHigh, preLow, preLast);

  return {
    hasRealPremarket: true,
    source: "REAL_PREMARKET",
    preLast,
    preHigh,
    preLow,
    preVol,
    preVWAP,
    holdQuality,
    rangePct,
    barCount: preBars.length
  };
}

function scoreBreakoutCandidate(x) {
  let score = 0;
  const notes = [];

  const price = safeNum(x.price, 0);
  const gapPct = safeNum(x.gapPct, 0);
  const volRatio = safeNum(x.preVolRatio, 0);
  const hold = safeNum(x.holdQuality, 0);
  const spreadBps = x.spreadBps == null ? null : safeNum(x.spreadBps, null);
  const rangePct = safeNum(x.preRangePct, 99999);
  const prevDayRet = safeNum(x.prevDayRet, 0);
  const prevCloseStrength = safeNum(x.prevCloseStrength, 0);
  const preDollarVol = safeNum(x.preDollarVol, 0);
  const abovePreVWAP = !!x.abovePreVWAP;
  const abovePrevHigh = !!x.abovePrevHigh;
  const source = x.source || "NONE";
  const feed = x.feed || "unknown";

  if (source !== "REAL_PREMARKET") {
    notes.push("Gerçek premarket verisi yok");
    return {
      score: 0,
      decision: "ALMA",
      notes,
      quality: "LOW"
    };
  }

  if (feed === "sip") {
    score += 4;
    notes.push("SIP feed");
  } else {
    notes.push("IEX feed");
  }

  if (price >= 0.2 && price <= 10) {
    score += 8;
  } else if (price > 10 && price <= 20) {
    score += 4;
  } else if (price > 20) {
    score -= 4;
    notes.push("Fiyat yüksek, breakout verimi düşebilir");
  } else if (price < 0.2) {
    score -= 8;
    notes.push("Aşırı düşük fiyat");
  }

  if (gapPct >= 2 && gapPct < 5) {
    score += 8;
  } else if (gapPct >= 5 && gapPct < 15) {
    score += 14;
  } else if (gapPct >= 15 && gapPct < 35) {
    score += 18;
  } else if (gapPct >= 35 && gapPct < 80) {
    score += 12;
    notes.push("Aşırı sıcak gap");
  } else if (gapPct >= 80) {
    score += 4;
    notes.push("Çok aşırı gap");
  } else if (gapPct < 0) {
    score -= 10;
  }

  if (volRatio >= 1.2 && volRatio < 2) {
    score += 10;
  } else if (volRatio >= 2 && volRatio < 4) {
    score += 18;
  } else if (volRatio >= 4) {
    score += 26;
    notes.push("Hacim anomalisi güçlü");
  } else if (volRatio < 0.8) {
    score -= 12;
  }

  if (preDollarVol >= 100000 && preDollarVol < 500000) {
    score += 8;
  } else if (preDollarVol >= 500000 && preDollarVol < 2000000) {
    score += 14;
  } else if (preDollarVol >= 2000000) {
    score += 18;
  } else if (preDollarVol < 50000) {
    score -= 10;
    notes.push("Premarket dollar volume zayıf");
  }

  if (hold >= 70 && hold < 85) {
    score += 12;
  } else if (hold >= 85) {
    score += 18;
  } else if (hold >= 55) {
    score += 6;
  } else if (hold < 40) {
    score -= 10;
    notes.push("Premarket hold zayıf");
  }

  if (abovePreVWAP) {
    score += 10;
  } else {
    score -= 8;
    notes.push("Premarket VWAP altında");
  }

  if (abovePrevHigh) {
    score += 12;
    notes.push("Previous day high üstünde");
  }

  if (spreadBps == null) {
    notes.push("Spread unavailable");
  } else if (spreadBps <= 60) {
    score += 10;
  } else if (spreadBps <= 120) {
    score += 5;
  } else if (spreadBps > 250) {
    score -= 12;
    notes.push("Spread geniş");
  }

  if (rangePct <= 12) {
    score += 8;
  } else if (rangePct <= 25) {
    score += 4;
  } else if (rangePct > 45) {
    score -= 8;
    notes.push("Premarket range aşırı geniş");
  }

  if (prevCloseStrength >= 80) {
    score += 6;
  }
  if (prevDayRet >= 5 && prevDayRet <= 40) {
    score += 4;
  } else if (prevDayRet > 70) {
    score -= 4;
    notes.push("Önceki gün aşırı uzama");
  }

  if (
    price <= 5 &&
    gapPct >= 8 &&
    volRatio >= 2 &&
    abovePreVWAP
  ) {
    score += 8;
    notes.push("Microcap catalyst uyumu");
  }

  score = clamp(Math.round(score), 0, 100);

  let decision = "ALMA";
  let quality = "LOW";

  if (
    score >= 78 &&
    volRatio >= 2 &&
    hold >= 70 &&
    abovePreVWAP &&
    abovePrevHigh &&
    (spreadBps == null || spreadBps <= 180)
  ) {
    decision = feed === "sip" ? "GÜÇLÜ AL" : "AL";
    quality = feed === "sip" ? "HIGH" : "MEDIUM";
  } else if (
    score >= 62 &&
    volRatio >= 1.2 &&
    hold >= 55 &&
    abovePreVWAP &&
    (spreadBps == null || spreadBps <= 250)
  ) {
    decision = "AL";
    quality = "MEDIUM";
  }

  return { score, decision, notes, quality };
}

function buildCandidateFromData({
  symbol,
  feed,
  snapshot,
  dailyBars,
  minuteBars,
  tradeDate,
  cutoffTime
}) {
  const dailyCtx = getDailyContext(dailyBars, tradeDate);
  if (!dailyCtx) return null;

  const { prevBar, prev2Bar, priorDates } = dailyCtx;

  const prevClose = safeNum(prevBar.c, 0);
  const prevHigh = safeNum(prevBar.h, 0);
  const prevCloseStrength = computeCloseStrength(prevBar);
  const prevDayRet =
    safeNum(prev2Bar.c, 0) > 0
      ? ((safeNum(prevBar.c, 0) - safeNum(prev2Bar.c, 0)) / safeNum(prev2Bar.c, 0)) * 100
      : 0;

  const preCtx = buildPremarketContextForDate(minuteBars, tradeDate, cutoffTime);
  const baseline = computeSameTimePremarketBaseline(minuteBars, priorDates, cutoffTime);

  const latestQuote = snapshot?.latestQuote || {};
  const bid = safeNum(latestQuote.bp, null);
  const ask = safeNum(latestQuote.ap, null);
  const spreadBps =
    bid != null && ask != null && bid > 0 && ask >= bid
      ? ((ask - bid) / ((ask + bid) / 2)) * 10000
      : null;

  const price = preCtx.preLast;
  const gapPct =
    price != null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;

  const preVolRatio =
    preCtx.preVol > 0 && baseline.baselineMedian > 0
      ? preCtx.preVol / baseline.baselineMedian
      : 0;

  const preDollarVol =
    price != null && preCtx.preVol > 0
      ? price * preCtx.preVol
      : 0;

  const abovePreVWAP =
    preCtx.preVWAP != null && price != null ? price > preCtx.preVWAP : false;

  const abovePrevHigh =
    price != null && prevHigh > 0 ? price > prevHigh : false;

  const scored = scoreBreakoutCandidate({
    price,
    gapPct,
    preVolRatio,
    holdQuality: preCtx.holdQuality,
    spreadBps,
    preRangePct: preCtx.rangePct,
    prevDayRet,
    prevCloseStrength,
    preDollarVol,
    abovePreVWAP,
    abovePrevHigh,
    source: preCtx.source,
    feed
  });

  return {
    symbol,
    feed,
    source: preCtx.source,
    decision: scored.decision,
    quality: scored.quality,
    score: scored.score,
    notes: scored.notes.join(" | "),

    price: roundSmart(price),
    prevClose: roundSmart(prevClose),
    prevHigh: roundSmart(prevHigh),
    gapPct: roundSmart(gapPct),

    preVol: Math.round(preCtx.preVol),
    preVolBaselineMedian: Math.round(baseline.baselineMedian),
    preVolRatio: roundSmart(preVolRatio),
    preDollarVol: Math.round(preDollarVol),

    preVWAP: roundSmart(preCtx.preVWAP),
    abovePreVWAP,
    holdQuality: roundSmart(preCtx.holdQuality),
    preRangePct: roundSmart(preCtx.rangePct),

    prevDayRet: roundSmart(prevDayRet),
    prevCloseStrength: roundSmart(prevCloseStrength),

    bid: roundSmart(bid),
    ask: roundSmart(ask),
    spreadBps: roundSmart(spreadBps),

    samples: baseline.samples,
    abovePrevHigh
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

function summarizeBreakout(rows) {
  const picks = rows
    .filter((r) => r.decision === "GÜÇLÜ AL" || r.decision === "AL")
    .slice(0, 3);

  const vals = picks
    .map((r) => (r.realizedPremarketTo30HighPct == null ? null : Number(r.realizedPremarketTo30HighPct)))
    .filter((v) => v != null && Number.isFinite(v));

  return {
    total: rows.length,
    picks: picks.length,
    strong: rows.filter((r) => r.decision === "GÜÇLÜ AL").length,
    buy: rows.filter((r) => r.decision === "AL").length,
    avgPremarketTo30: vals.length ? roundSmart(avg(vals)) : null,
    hit10: vals.filter((v) => v >= 10).length,
    hit15: vals.filter((v) => v >= 15).length
  };
}

async function buildBacktestBreakout(dateStr, symbols) {
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
    const mergedMinuteBars = [...prior5, ...trade1].sort(
      (a, b) => new Date(a.t) - new Date(b.t)
    );

    const row = buildCandidateFromData({
      symbol,
      feed: ALPACA_FEED,
      snapshot: null,
      dailyBars,
      minuteBars: mergedMinuteBars,
      tradeDate: dateStr,
      cutoffTime: "09:25:00"
    });

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
      safeNum(a.score, 0) * 100 +
      safeNum(a.preVolRatio, 0);

    const bKey =
      decisionRank(b.decision) * 100000 +
      safeNum(b.score, 0) * 100 +
      safeNum(b.preVolRatio, 0);

    return bKey - aKey;
  });

  return {
    tradeDate: dateStr,
    session: "backtest-premarket",
    cutoffTime: "09:25:00",
    feed: ALPACA_FEED,
    rows,
    summary: summarizeBreakout(rows)
  };
}

async function buildLiveBreakout(symbols) {
  const session = getSessionLabelNow();
  const today = getTodayNyDate();

  if (session === "weekend") {
    return {
      session,
      feed: ALPACA_FEED,
      cutoffTime: null,
      rows: [],
      summary: { total: 0, picks: 0, strong: 0, buy: 0, avgPremarketTo30: null, hit10: 0, hit15: 0 },
      message: "Hafta sonu. Canlı breakout taraması üretmiyorum."
    };
  }

  if (session === "closed") {
    return {
      session,
      feed: ALPACA_FEED,
      cutoffTime: null,
      rows: [],
      summary: { total: 0, picks: 0, strong: 0, buy: 0, avgPremarketTo30: null, hit10: 0, hit15: 0 },
      message: "ABD piyasası kapalı. Breakout taraması için premarket/open beklenmeli."
    };
  }

  const nowNy = getNowNyTime();
  let cutoffTime = "09:25:00";

  if (session === "premarket") {
    cutoffTime = nowNy < "04:00:00" ? "04:00:00" : (nowNy > "09:25:00" ? "09:25:00" : nowNy);
  } else {
    cutoffTime = "09:25:00";
  }

  const lookbackStart = new Date(Date.now() - 12 * 86400000);

  const dailyStart = zonedDateTimeToUtcISO(
    lookbackStart.toISOString().slice(0, 10),
    "00:00"
  );
  const dailyEnd = new Date().toISOString();

  const priorMinuteStart = zonedDateTimeToUtcISO(
    lookbackStart.toISOString().slice(0, 10),
    "04:00"
  );
  const priorMinuteEnd = zonedDateTimeToUtcISO(today, "03:59");

  const tradeMinuteStart = zonedDateTimeToUtcISO(today, "04:00");
  const tradeMinuteEnd = new Date().toISOString();

  const [snapshotsRaw, dailyBarsMap, prior5MinMap, trade1MinMap] = await Promise.all([
    fetchSnapshots(symbols, ALPACA_FEED),
    fetchAllBars(symbols, "1Day", dailyStart, dailyEnd, ALPACA_FEED, 10000),
    fetchAllBars(symbols, "5Min", priorMinuteStart, priorMinuteEnd, ALPACA_FEED, 10000),
    fetchAllBars(symbols, "1Min", tradeMinuteStart, tradeMinuteEnd, ALPACA_FEED, 10000)
  ]);

  const rows = [];

  for (const symbol of symbols) {
    const dailyBars = dailyBarsMap[symbol] || [];
    const prior5 = prior5MinMap[symbol] || [];
    const trade1 = trade1MinMap[symbol] || [];
    const mergedMinuteBars = [...prior5, ...trade1].sort(
      (a, b) => new Date(a.t) - new Date(b.t)
    );

    const row = buildCandidateFromData({
      symbol,
      feed: ALPACA_FEED,
      snapshot: snapshotsRaw[symbol] || {},
      dailyBars,
      minuteBars: mergedMinuteBars,
      tradeDate: today,
      cutoffTime
    });

    if (!row) continue;
    rows.push(row);
  }

  rows.sort((a, b) => {
    const aKey =
      decisionRank(a.decision) * 100000 +
      safeNum(a.score, 0) * 100 +
      safeNum(a.preVolRatio, 0);

    const bKey =
      decisionRank(b.decision) * 100000 +
      safeNum(b.score, 0) * 100 +
      safeNum(b.preVolRatio, 0);

    return bKey - aKey;
  });

  return {
    session,
    feed: ALPACA_FEED,
    cutoffTime,
    rows,
    summary: summarizeBreakout(rows),
    message: null
  };
}

app.get("/test", (req, res) => {
  res.json({ status: "SERVER OK" });
});

app.get("/api/default-symbols", (req, res) => {
  res.json({ symbols: DEFAULT_SYMBOLS });
});

app.get("/api/live-breakout", async (req, res) => {
  try {
    const symbols = parseSymbols(req.query.symbols);
    const data = await buildLiveBreakout(symbols);
    res.json(data);
  } catch (err) {
    console.error("LIVE_BREAKOUT error:", err);
    res.status(500).json({ error: "server error", detail: err.message });
  }
});

app.get("/api/backtest-breakout", async (req, res) => {
  try {
    const dateStr = String(req.query.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: "date parametresi YYYY-MM-DD formatında olmalı" });
    }

    const symbols = parseSymbols(req.query.symbols);
    const data = await buildBacktestBreakout(dateStr, symbols);
    res.json(data);
  } catch (err) {
    console.error("BACKTEST_BREAKOUT error:", err);
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
  console.log(`Breakout engine running on port ${PORT}`);
});
