import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { marketStatus, nyDate } from "./market.js";
import { evaluate } from "./strategy.js";
import { Ledger } from "./ledger.js";
import { SimBroker } from "./brokers/sim.js";
import { IBBroker } from "./brokers/ib.js";

const STATE_PATH = (mode) => path.join(DATA_DIR, `state-${mode}.json`);
const emptyState = () => ({ lots: {}, trades: [], fills: [], equity: [], daily: {}, logs: [], sim: null, initialCapital: null });

export class Engine {
  constructor(cfg) {
    this.cfg = cfg;
    this.running = false;
    this.halted = null; // reason string when the daily loss limit tripped
    this.signals = {};
    this.account = null;
    this.positions = [];
    this.orders = [];
    this.lastCycle = null;
    this.busy = false;
    this.pendingEntries = new Map(); // symbol -> timestamp, avoids duplicate entries before IB reports the order
    this.closing = new Map(); // symbol -> timestamp, avoids duplicate exit orders before positions refresh
  }

  // Sends at most one exit per symbol every 2 minutes, so a lagging position report can't trigger a double sell.
  async closeSafely(symbol) {
    const t = this.closing.get(symbol);
    if (t && Date.now() - t < 120000) return false;
    this.closing.set(symbol, Date.now());
    await this.broker.closePosition(symbol);
    return true;
  }

  // ---------- persistence ----------
  loadState() {
    try {
      this.state = { ...emptyState(), ...JSON.parse(fs.readFileSync(STATE_PATH(this.cfg.mode), "utf8")) };
    } catch {
      this.state = emptyState();
    }
    this.ledger = new Ledger(this.state);
  }

  saveState() {
    if (this.broker?.name === "sim") this.state.sim = this.broker.snapshot();
    const tmp = STATE_PATH(this.cfg.mode) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, STATE_PATH(this.cfg.mode));
  }

  log(level, msg) {
    const entry = { time: new Date().toISOString(), level, msg };
    this.state.logs.push(entry);
    if (this.state.logs.length > 500) this.state.logs.splice(0, this.state.logs.length - 500);
    console.log(`[${entry.time}] ${level.toUpperCase()} ${msg}`);
  }

  // ---------- lifecycle ----------
  async start() {
    this.loadState();
    this.broker = this.createBroker();
    this.broker.on("fill", (f) => this.onFill(f));
    this.broker.on("log", (lvl, m) => this.log(lvl, m));
    await this.tryConnect();
    this.scheduleLoop();
    this.saveTimer = setInterval(() => this.saveState(), 5000);
  }

  async stop() {
    clearTimeout(this.loopTimer);
    clearInterval(this.saveTimer);
    await this.broker?.disconnect();
    this.saveState();
  }

  createBroker() {
    const mode = this.cfg.mode;
    if (mode === "sim") return new SimBroker(this.cfg, this.state.sim);
    if (mode === "paper") return new IBBroker(this.cfg, false);
    if (mode === "live") return new IBBroker(this.cfg, true);
    throw new Error(`وضع غير معروف: ${mode}`);
  }

  async switchMode(cfg) {
    this.running = false;
    await this.stop();
    this.cfg = cfg;
    this.halted = null;
    this.signals = {};
    this.account = null;
    this.positions = [];
    this.orders = [];
    await this.start();
    this.log("info", `تم التبديل إلى وضع: ${this.modeLabel()}`);
  }

  updateConfig(cfg) {
    this.cfg = cfg;
    if (this.broker) this.broker.cfg = cfg;
  }

  modeLabel() {
    return { sim: "محاكاة", paper: "حساب تجريبي (Paper)", live: "حساب حقيقي (Live)" }[this.cfg.mode];
  }

  async tryConnect() {
    try {
      await this.broker.connect();
      this.log("info", `تم الاتصال — الوضع: ${this.modeLabel()}`);
    } catch (e) {
      this.log("error", e.message);
    }
  }

  scheduleLoop() {
    const sec = this.cfg.mode === "sim" ? this.cfg.engine.simCycleSeconds : this.cfg.engine.cycleSeconds;
    this.loopTimer = setTimeout(async () => {
      await this.cycle().catch((e) => this.log("error", `خطأ في الدورة: ${e.message}`));
      this.scheduleLoop();
    }, sec * 1000);
  }

  startBot() {
    if (this.halted) throw new Error(`البوت متوقف بسبب: ${this.halted}. أعد ضبطه من زر "إعادة التفعيل" أولاً.`);
    this.running = true;
    this.log("info", "▶ تم تشغيل التداول الآلي");
  }

  stopBot() {
    this.running = false;
    this.log("info", "⏸ تم إيقاف التداول الآلي (المراكز المفتوحة وأوامر الحماية باقية)");
  }

  async kill() {
    this.running = false;
    await this.broker.cancelAll();
    for (const p of this.positions) await this.closeSafely(p.symbol);
    this.log("warn", "⛔ إيقاف طارئ: أُلغيت كل الأوامر وأُغلقت كل المراكز");
  }

  resetHalt() {
    this.halted = null;
    this.log("info", "تمت إعادة تفعيل البوت بعد التوقف");
  }

  async closeOne(symbol) {
    if (!(await this.closeSafely(symbol))) throw new Error("أمر إغلاق لهذا السهم أُرسل للتو");
    this.log("info", `إغلاق يدوي لمركز ${symbol}`);
  }

  onFill(f) {
    const trade = this.ledger.addFill(f);
    this.log("trade", `${f.side === "BUY" ? "شراء" : "بيع"} ${f.qty} × ${f.symbol} @ ${f.price.toFixed(2)}`);
    if (trade) {
      const sign = trade.pnl >= 0 ? "ربح" : "خسارة";
      this.log("trade", `صفقة مغلقة ${trade.symbol}: ${sign} ${trade.pnl.toFixed(2)}$ (${trade.pnlPct.toFixed(2)}%)`);
    }
    this.pendingEntries.delete(f.symbol);
  }

  // ---------- main loop ----------
  async cycle() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.broker.isConnected()) {
        await this.tryConnect();
        if (!this.broker.isConnected()) return;
      }
      this.account = await this.broker.getAccount();
      this.positions = await this.broker.getPositions();
      this.orders = await this.broker.getOpenOrders();
      this.lastCycle = new Date().toISOString();
      const equity = this.account.netLiquidation;
      if (equity == null) return; // IB account values not received yet

      if (this.state.initialCapital == null) this.state.initialCapital = this.cfg.initialCapital ?? equity;
      this.recordEquity(equity);

      const mkt = marketStatus();
      const ignoreHours = this.cfg.mode === "sim" && this.cfg.sim.ignoreMarketHours;
      const tradingWindow = ignoreHours || mkt.isOpen;

      // Evaluate signals for the watchlist (also shown on the dashboard while the bot is stopped).
      if (tradingWindow || !Object.keys(this.signals).length) await this.refreshSignals();

      if (!this.running) return;
      const r = this.cfg.risk;

      // Daily loss limit.
      const day = this.state.daily[this.dayKey()];
      const dayPnLPct = ((equity - day.start) / day.start) * 100;
      if (dayPnLPct <= -r.dailyLossLimitPct) {
        this.halted = `تجاوز حد الخسارة اليومي (${dayPnLPct.toFixed(2)}%)`;
        this.running = false;
        this.log("warn", `⛔ ${this.halted} — تم إيقاف البوت`);
        if (r.flattenOnHalt) await this.kill();
        return;
      }

      if (!tradingWindow) return;

      // Flatten before the close to avoid overnight risk.
      if (!ignoreHours && mkt.minutesToClose <= r.flattenMinutesBeforeClose) {
        const toClose = this.positions.filter((p) => !this.closing.has(p.symbol) || Date.now() - this.closing.get(p.symbol) >= 120000);
        if (toClose.length) {
          this.log("info", "اقتراب إغلاق السوق — إغلاق كل المراكز");
          for (const p of toClose) await this.closeSafely(p.symbol);
        }
        return;
      }

      // Exit signals for held positions.
      for (const p of this.positions) {
        const sig = this.signals[p.symbol];
        if (sig?.action === "SELL") {
          if (await this.closeSafely(p.symbol)) this.log("info", `إشارة خروج ${p.symbol}: ${sig.reason}`);
        }
      }

      if (!ignoreHours && mkt.minutesSinceOpen < r.openDelayMinutes) return;
      await this.considerEntries(equity);
    } finally {
      this.busy = false;
    }
  }

  dayKey() {
    return this.cfg.mode === "sim" && this.cfg.sim.ignoreMarketHours ? new Date().toISOString().slice(0, 10) : nyDate();
  }

  recordEquity(equity) {
    const key = this.dayKey();
    const d = (this.state.daily[key] ||= { start: equity, end: equity, high: equity, low: equity });
    d.end = equity;
    d.high = Math.max(d.high, equity);
    d.low = Math.min(d.low, equity);

    const eq = this.state.equity;
    const now = Date.now();
    const minGap = this.cfg.mode === "sim" ? 5000 : 60000;
    if (!eq.length || now - new Date(eq.at(-1).t).getTime() >= minGap) {
      eq.push({ t: new Date(now).toISOString(), v: equity });
      if (eq.length > 20000) eq.splice(0, eq.length - 20000);
    }
  }

  async refreshSignals() {
    for (const symbol of this.cfg.watchlist) {
      try {
        const bars = await this.broker.getBars(symbol);
        this.signals[symbol] = { ...evaluate(bars, this.cfg.strategy), time: new Date().toISOString() };
      } catch (e) {
        this.signals[symbol] = { action: "HOLD", reason: e.message, price: null, indicators: {}, error: true };
      }
    }
    for (const s of Object.keys(this.signals)) if (!this.cfg.watchlist.includes(s)) delete this.signals[s];
  }

  async considerEntries(equity) {
    const r = this.cfg.risk;
    const held = new Set(this.positions.map((p) => p.symbol));
    const pendingSyms = new Set(this.orders.filter((o) => o.action === "BUY").map((o) => o.symbol));
    for (const [s, t] of this.pendingEntries) if (Date.now() - t > 120000) this.pendingEntries.delete(s);

    let openCount = held.size + [...pendingSyms].filter((s) => !held.has(s)).length;
    let cash = r.useMargin ? this.account.buyingPower : this.account.cash;

    if (r.pdtProtection && equity < 25000 && this.account.accountType !== "CASH" && this.ledger.dayTradesLast5Days() >= 3) {
      this.blocked = "حماية قاعدة PDT: 3 صفقات يومية خلال 5 أيام والرصيد أقل من 25,000$";
      return;
    }
    if (this.ledger.tradesToday() >= r.maxTradesPerDay) {
      this.blocked = `وصل الحد الأقصى للصفقات اليومية (${r.maxTradesPerDay})`;
      return;
    }
    this.blocked = null;

    for (const symbol of this.cfg.watchlist) {
      const sig = this.signals[symbol];
      if (!sig || sig.action !== "BUY" || !sig.price) continue;
      if (held.has(symbol) || pendingSyms.has(symbol) || this.pendingEntries.has(symbol)) continue;
      if (openCount >= r.maxOpenPositions) break;

      const budget = Math.min(equity * (r.maxPositionPct / 100), cash * 0.98);
      const qty = Math.floor(budget / sig.price);
      if (qty < 1) {
        this.log("info", `تجاهل إشارة ${symbol}: الرصيد لا يكفي لسهم واحد`);
        continue;
      }
      const takeProfit = sig.price * (1 + r.takeProfitPct / 100);
      const stopLoss = sig.price * (1 - r.stopLossPct / 100);
      try {
        await this.broker.placeBracket({ symbol, qty, entryPrice: sig.price, takeProfit, stopLoss });
        this.pendingEntries.set(symbol, Date.now());
        openCount++;
        cash -= qty * sig.price;
        this.log("info", `أمر شراء ${qty} × ${symbol} @ ~${sig.price.toFixed(2)} | هدف ${takeProfit.toFixed(2)} | وقف ${stopLoss.toFixed(2)} — ${sig.reason}`);
      } catch (e) {
        this.log("error", `فشل أمر ${symbol}: ${e.message}`);
      }
    }
  }

  // ---------- analytics ----------
  metrics() {
    const trades = this.state.trades;
    const equity = this.account?.netLiquidation ?? null;
    const initial = this.state.initialCapital;
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const sum = (a) => a.reduce((x, t) => x + t.pnl, 0);
    const grossWin = sum(wins), grossLoss = Math.abs(sum(losses));

    let peak = -Infinity, maxDD = 0;
    for (const p of this.state.equity) {
      peak = Math.max(peak, p.v);
      maxDD = Math.max(maxDD, (peak - p.v) / peak);
    }

    const today = this.state.daily[this.dayKey()];
    const days = Object.entries(this.state.daily).sort(([a], [b]) => a.localeCompare(b));
    const dailyRows = days.slice(-60).map(([date, d]) => ({ date, pnl: d.end - d.start, pct: ((d.end - d.start) / d.start) * 100 }));

    return {
      equity,
      initialCapital: initial,
      totalPnL: equity != null && initial ? equity - initial : null,
      growthPct: equity != null && initial ? ((equity - initial) / initial) * 100 : null,
      todayPnL: this.account?.dailyPnL ?? (today ? today.end - today.start : null),
      todayPct: today ? ((today.end - today.start) / today.start) * 100 : null,
      realizedPnL: sum(trades),
      tradeCount: trades.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : null,
      avgWin: wins.length ? grossWin / wins.length : null,
      avgLoss: losses.length ? -grossLoss / losses.length : null,
      profitFactor: grossLoss ? grossWin / grossLoss : null,
      maxDrawdownPct: maxDD * 100,
      profitableDays: dailyRows.filter((d) => d.pnl > 0).length,
      losingDays: dailyRows.filter((d) => d.pnl < 0).length,
      daily: dailyRows,
    };
  }

  symbolStats() {
    const by = {};
    for (const t of this.state.trades) {
      const s = (by[t.symbol] ||= { symbol: t.symbol, trades: 0, wins: 0, pnl: 0 });
      s.trades++;
      s.pnl += t.pnl;
      if (t.pnl > 0) s.wins++;
    }
    for (const p of this.positions) {
      const s = (by[p.symbol] ||= { symbol: p.symbol, trades: 0, wins: 0, pnl: 0 });
      s.unrealized = p.unrealizedPnL;
    }
    return Object.values(by)
      .map((s) => ({ ...s, total: s.pnl + (s.unrealized || 0), winRate: s.trades ? (s.wins / s.trades) * 100 : null }))
      .sort((a, b) => b.total - a.total);
  }

  equitySeries(maxPoints = 600) {
    const eq = this.state.equity;
    if (eq.length <= maxPoints) return eq;
    const step = eq.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) out.push(eq[Math.floor(i * step)]);
    out.push(eq.at(-1));
    return out;
  }

  status() {
    return {
      mode: this.cfg.mode,
      modeLabel: this.modeLabel(),
      connected: this.broker?.isConnected() ?? false,
      running: this.running,
      halted: this.halted,
      blocked: this.blocked ?? null,
      lastCycle: this.lastCycle,
      market: marketStatus(),
      ignoreMarketHours: this.cfg.mode === "sim" && this.cfg.sim.ignoreMarketHours,
      lastError: this.broker?.lastError ?? null,
    };
  }

  dashboard() {
    return {
      status: this.status(),
      account: this.account,
      metrics: this.metrics(),
      positions: this.positions,
      orders: this.orders,
      signals: this.cfg.watchlist.map((s) => ({ symbol: s, ...(this.signals[s] || { action: "HOLD", reason: "بانتظار البيانات" }) })),
      symbolStats: this.symbolStats(),
      trades: this.state.trades.slice(-200).reverse(),
      equity: this.equitySeries(),
      logs: this.state.logs.slice(-150).reverse(),
    };
  }
}
