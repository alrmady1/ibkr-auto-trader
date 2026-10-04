import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
const DEFAULT_PATH = path.join(ROOT, "config.default.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(base[k] ?? {}, v) : v;
  }
  return out;
}

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_PATH, "utf8"));
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  // Merge so that new default keys appear after upgrades.
  return deepMerge(defaults, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

const num = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`قيمة غير صالحة: ${v} (المسموح ${min}–${max})`);
  return n;
};

// Validates a user-submitted settings patch and returns the merged config.
export function applySettings(cfg, patch) {
  const next = structuredClone(cfg);
  if (patch.watchlist) {
    const list = [...new Set(String(patch.watchlist).toUpperCase().split(/[\s,،]+/).filter(Boolean))];
    if (!list.every((s) => /^[A-Z.]{1,6}$/.test(s))) throw new Error("رموز أسهم غير صالحة");
    if (list.length < 1 || list.length > 40) throw new Error("قائمة المراقبة يجب أن تحتوي 1–40 سهماً");
    next.watchlist = list;
  }
  const r = patch.risk || {};
  const rr = next.risk;
  if (r.takeProfitPct != null) rr.takeProfitPct = num(r.takeProfitPct, 0.1, 20);
  if (r.stopLossPct != null) rr.stopLossPct = num(r.stopLossPct, 0.1, 20);
  if (r.maxPositionPct != null) rr.maxPositionPct = num(r.maxPositionPct, 1, 100);
  if (r.maxOpenPositions != null) rr.maxOpenPositions = Math.round(num(r.maxOpenPositions, 1, 30));
  if (r.maxTradesPerDay != null) rr.maxTradesPerDay = Math.round(num(r.maxTradesPerDay, 1, 200));
  if (r.dailyLossLimitPct != null) rr.dailyLossLimitPct = num(r.dailyLossLimitPct, 0.2, 50);
  if (r.flattenMinutesBeforeClose != null) rr.flattenMinutesBeforeClose = Math.round(num(r.flattenMinutesBeforeClose, 0, 120));
  if (r.useMargin != null) rr.useMargin = Boolean(r.useMargin);
  if (r.pdtProtection != null) rr.pdtProtection = Boolean(r.pdtProtection);

  const s = patch.strategy || {};
  if (s.name != null) {
    if (!["rsi_pullback", "ema_cross"].includes(s.name)) throw new Error("استراتيجية غير معروفة");
    next.strategy.name = s.name;
  }
  if (s.rsiBuy != null) next.strategy.rsiBuy = num(s.rsiBuy, 5, 50);
  if (s.rsiSell != null) next.strategy.rsiSell = num(s.rsiSell, 50, 95);

  if (patch.initialCapital !== undefined) {
    next.initialCapital = patch.initialCapital === null || patch.initialCapital === "" ? null : num(patch.initialCapital, 1, 1e10);
  }
  if (patch.ib) {
    if (patch.ib.host != null) next.ib.host = String(patch.ib.host).trim() || "127.0.0.1";
    if (patch.ib.paperPort != null) next.ib.paperPort = Math.round(num(patch.ib.paperPort, 1, 65535));
    if (patch.ib.livePort != null) next.ib.livePort = Math.round(num(patch.ib.livePort, 1, 65535));
    if (patch.ib.clientId != null) next.ib.clientId = Math.round(num(patch.ib.clientId, 0, 999999));
    if (patch.ib.accountId != null) next.ib.accountId = String(patch.ib.accountId).trim();
  }
  if (patch.cloud) {
    const cl = patch.cloud;
    if (cl.url != null) {
      const url = String(cl.url).trim().replace(/\/+$/, "");
      if (url && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) throw new Error("رابط المنصة السحابية يجب أن يبدأ بـ https://");
      next.cloud.url = url;
    }
    if (cl.token != null && cl.token !== "") next.cloud.token = String(cl.token).trim();
    if (cl.enabled != null) next.cloud.enabled = Boolean(cl.enabled);
  }
  return next;
}
