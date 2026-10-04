import { ema, rsi } from "./indicators.js";

const round = (v, d = 2) => (v == null ? null : Number(v.toFixed(d)));

// Returns { action: "BUY" | "SELL" | "HOLD", reason, price, indicators }.
// Long-only: "SELL" means exit an existing long position.
export function evaluate(bars, cfg) {
  const closes = bars.map((b) => b.close);
  const price = closes.at(-1);
  const need = Math.max(cfg.trendEma, cfg.emaSlow, cfg.rsiPeriod) + 2;
  if (closes.length < need) {
    return { action: "HOLD", reason: `بيانات غير كافية (${closes.length}/${need})`, price, indicators: {} };
  }

  const trendLine = ema(closes, cfg.trendEma);
  const trend = trendLine.at(-1);
  const r = rsi(closes, cfg.rsiPeriod);
  const rNow = r.at(-1), rPrev = r.at(-2);
  const fast = ema(closes, cfg.emaFast), slow = ema(closes, cfg.emaSlow);
  const fNow = fast.at(-1), fPrev = fast.at(-2), sNow = slow.at(-1), sPrev = slow.at(-2);
  const indicators = { rsi: round(rNow, 1), trendEma: round(trend), emaFast: round(fNow), emaSlow: round(sNow) };
  // Uptrend = trend EMA rising over the last 10 bars, with price no more than 1% below it (dips may pierce it).
  const upTrend = trend > trendLine.at(-11) && price > trend * 0.99;

  if (cfg.name === "ema_cross") {
    if (fPrev <= sPrev && fNow > sNow && upTrend)
      return { action: "BUY", reason: "تقاطع EMA صاعد ضمن اتجاه صاعد", price, indicators };
    if (fPrev >= sPrev && fNow < sNow)
      return { action: "SELL", reason: "تقاطع EMA هابط", price, indicators };
    return { action: "HOLD", reason: upTrend ? "اتجاه صاعد بانتظار تقاطع" : "خارج الاتجاه الصاعد", price, indicators };
  }

  // rsi_pullback: buy a dip inside an uptrend once RSI turns back up through the oversold line.
  if (upTrend && rPrev < cfg.rsiBuy && rNow >= cfg.rsiBuy)
    return { action: "BUY", reason: `ارتداد RSI من ${round(rPrev, 1)} فوق ${cfg.rsiBuy} ضمن اتجاه صاعد`, price, indicators };
  if (rNow >= cfg.rsiSell)
    return { action: "SELL", reason: `RSI مرتفع (${round(rNow, 1)})`, price, indicators };
  return {
    action: "HOLD",
    reason: !upTrend ? "لا يوجد اتجاه صاعد" : rNow < cfg.rsiBuy ? "تشبع بيعي – بانتظار الارتداد" : "لا توجد إشارة",
    price, indicators,
  };
}
