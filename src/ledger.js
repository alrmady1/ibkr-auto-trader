import { nyDate } from "./market.js";

// FIFO trade ledger built from fills. Produces closed round-trip trades with realized P&L.
export class Ledger {
  constructor(state) {
    this.state = state; // { lots: {SYM: [{qty, price, time, commission}]}, trades: [], fills: [] }
  }

  addFill({ symbol, side, qty, price, time = new Date().toISOString(), commission = 0, orderId = null, execId = null }) {
    const s = this.state;
    if (execId && s.fills.some((f) => f.execId === execId)) return null; // duplicate execution report
    s.fills.push({ symbol, side, qty, price, time, commission, orderId, execId });
    if (s.fills.length > 5000) s.fills.splice(0, s.fills.length - 5000);

    const lots = (s.lots[symbol] ||= []);
    if (side === "BUY") {
      lots.push({ qty, price, time, commission });
      return null;
    }

    let remaining = qty;
    let cost = 0, entryComm = 0, matched = 0, entryTime = null;
    while (remaining > 0 && lots.length) {
      const lot = lots[0];
      const take = Math.min(lot.qty, remaining);
      cost += take * lot.price;
      entryComm += lot.commission * (take / lot.qty);
      lot.commission -= lot.commission * (take / lot.qty);
      entryTime ||= lot.time;
      lot.qty -= take;
      remaining -= take;
      matched += take;
      if (lot.qty <= 1e-9) lots.shift();
    }
    if (!lots.length) delete s.lots[symbol];
    if (matched === 0) return null; // sell of a position opened outside the bot

    const entryPrice = cost / matched;
    const pnl = (price - entryPrice) * matched - entryComm - commission * (matched / qty);
    const trade = {
      symbol, qty: matched, entryPrice, exitPrice: price, entryTime, exitTime: time,
      pnl, pnlPct: (pnl / cost) * 100, commission: entryComm + commission * (matched / qty),
      dayTrade: nyDate(new Date(entryTime)) === nyDate(new Date(time)),
    };
    s.trades.push(trade);
    if (s.trades.length > 5000) s.trades.splice(0, s.trades.length - 5000);
    return trade;
  }

  // Day trades (same-day round trips) within the last 5 trading days, for the PDT rule.
  dayTradesLast5Days() {
    const cutoff = Date.now() - 7 * 86400000; // ~5 business days
    return this.state.trades.filter((t) => t.dayTrade && new Date(t.exitTime).getTime() >= cutoff).length;
  }

  tradesToday() {
    const today = nyDate();
    return this.state.fills.filter((f) => f.side === "BUY" && nyDate(new Date(f.time)) === today).length;
  }
}
