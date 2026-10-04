import { EventEmitter } from "node:events";

const BASE_PRICES = {
  AAPL: 230, MSFT: 430, NVDA: 125, AMZN: 190, GOOGL: 170, META: 560, AMD: 150, AVGO: 170,
  COST: 900, JNJ: 160, TSLA: 240, NFLX: 700, PEP: 165, KO: 70, V: 290, MA: 500, JPM: 220,
};

// In-memory paper broker with synthetic prices. Each tick appends one 5-minute bar per symbol.
export class SimBroker extends EventEmitter {
  constructor(cfg, saved) {
    super();
    this.cfg = cfg;
    this.name = "sim";
    this.connected = false;
    this.nextId = 1;
    this.cash = saved?.cash ?? cfg.sim.startingCash;
    this.positions = saved?.positions ?? {}; // SYM -> { qty, avgCost }
    this.brackets = {}; // SYM -> { qty, tp, sl, ids }
    this.series = {};
    this.realized = 0;
    this.dayRealized = 0;
  }

  snapshot() {
    return { cash: this.cash, positions: this.positions };
  }

  async connect() {
    this.connected = true;
    this.timer = setInterval(() => this.tick(), 2000);
  }

  async disconnect() {
    clearInterval(this.timer);
    this.connected = false;
  }

  isConnected() { return this.connected; }

  ensureSeries(symbol) {
    if (this.series[symbol]) return this.series[symbol];
    let price = BASE_PRICES[symbol] ?? 50 + (symbol.charCodeAt(0) % 20) * 10;
    const bars = [];
    const t0 = Date.now() - 200 * 300000;
    const drift = 0.00004 + (symbol.charCodeAt(symbol.length - 1) % 5) * 0.00001;
    const s = { bars, drift, vol: 0.0035, anchor: price };
    for (let i = 0; i < 200; i++) {
      price = this.step(s, price);
      bars.push(this.makeBar(t0 + i * 300000, bars.at(-1)?.close ?? price, price, s.vol));
    }
    this.series[symbol] = s;
    return s;
  }

  step(s, price) {
    // Drift + short-lived momentum swings around a slowly rising anchor, so pullbacks and rebounds occur.
    s.anchor *= 1 + s.drift;
    const shock = (Math.random() + Math.random() + Math.random() - 1.5) * 2 * s.vol;
    s.mom = (s.mom ?? 0) * 0.8 + shock;
    const revert = ((s.anchor - price) / price) * 0.01;
    return Math.max(1, price * (1 + s.drift + revert + s.mom * 0.6));
  }

  makeBar(time, open, close, vol) {
    const hi = Math.max(open, close) * (1 + Math.random() * vol * 0.6);
    const lo = Math.min(open, close) * (1 - Math.random() * vol * 0.6);
    return { time: new Date(time).toISOString(), open, high: hi, low: lo, close, volume: Math.round(1e4 + Math.random() * 9e4) };
  }

  tick() {
    for (const [symbol, s] of Object.entries(this.series)) {
      const last = s.bars.at(-1);
      const bar = this.makeBar(Date.now(), last.close, this.step(s, last.close), s.vol);
      s.bars.push(bar);
      if (s.bars.length > 400) s.bars.shift();
      this.checkBracket(symbol, bar);
    }
  }

  checkBracket(symbol, bar) {
    const b = this.brackets[symbol];
    if (!b) return;
    if (bar.low <= b.sl) this.fill(symbol, "SELL", b.qty, Math.min(b.sl, bar.open), b.ids.sl);
    else if (bar.high >= b.tp) this.fill(symbol, "SELL", b.qty, Math.max(b.tp, bar.open), b.ids.tp);
    else return;
    delete this.brackets[symbol];
  }

  commission(qty) {
    return Math.max(this.cfg.sim.minCommission, qty * this.cfg.sim.commissionPerShare);
  }

  fill(symbol, side, qty, price, orderId) {
    const commission = this.commission(qty);
    const pos = this.positions[symbol] || { qty: 0, avgCost: 0 };
    if (side === "BUY") {
      pos.avgCost = (pos.avgCost * pos.qty + price * qty) / (pos.qty + qty);
      pos.qty += qty;
      this.cash -= price * qty + commission;
    } else {
      const r = (price - pos.avgCost) * qty - commission;
      this.realized += r;
      this.dayRealized += r;
      pos.qty -= qty;
      this.cash += price * qty - commission;
    }
    if (pos.qty <= 0) delete this.positions[symbol];
    else this.positions[symbol] = pos;
    this.emit("fill", { symbol, side, qty, price, commission, orderId, time: new Date().toISOString() });
  }

  lastPrice(symbol) {
    return this.ensureSeries(symbol).bars.at(-1).close;
  }

  async getAccount() {
    let mv = 0, upnl = 0;
    for (const [sym, p] of Object.entries(this.positions)) {
      const px = this.lastPrice(sym);
      mv += px * p.qty;
      upnl += (px - p.avgCost) * p.qty;
    }
    return {
      accountId: "SIM-DEMO",
      currency: "USD",
      netLiquidation: this.cash + mv,
      cash: this.cash,
      buyingPower: this.cash,
      grossPositionValue: mv,
      unrealizedPnL: upnl,
      realizedPnL: this.realized,
      dailyPnL: null,
      accountType: "SIMULATED",
    };
  }

  async getPositions() {
    return Object.entries(this.positions).map(([symbol, p]) => {
      const marketPrice = this.lastPrice(symbol);
      return {
        symbol, qty: p.qty, avgCost: p.avgCost, marketPrice,
        marketValue: marketPrice * p.qty, unrealizedPnL: (marketPrice - p.avgCost) * p.qty,
      };
    });
  }

  async getBars(symbol) {
    return this.ensureSeries(symbol).bars.slice(-200);
  }

  async getOpenOrders() {
    return Object.entries(this.brackets).flatMap(([symbol, b]) => [
      { orderId: b.ids.tp, symbol, action: "SELL", type: "LMT", qty: b.qty, price: b.tp, status: "Submitted" },
      { orderId: b.ids.sl, symbol, action: "SELL", type: "STP", qty: b.qty, price: b.sl, status: "Submitted" },
    ]);
  }

  async placeBracket({ symbol, qty, entryPrice, takeProfit, stopLoss }) {
    const ids = { parent: this.nextId++, tp: this.nextId++, sl: this.nextId++ };
    const px = this.lastPrice(symbol) * 1.0003; // slippage
    if (px * qty + this.commission(qty) > this.cash) throw new Error("رصيد نقدي غير كافٍ");
    this.fill(symbol, "BUY", qty, px, ids.parent);
    this.brackets[symbol] = { qty, tp: takeProfit, sl: stopLoss, ids };
    return ids.parent;
  }

  async closePosition(symbol) {
    delete this.brackets[symbol];
    const pos = this.positions[symbol];
    if (!pos) return;
    this.fill(symbol, "SELL", pos.qty, this.lastPrice(symbol) * 0.9997, this.nextId++);
  }

  async cancelAll() {
    this.brackets = {};
  }
}
