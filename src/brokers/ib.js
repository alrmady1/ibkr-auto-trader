import { EventEmitter } from "node:events";
import ibPkg from "@stoqey/ib";

const { IBApi, EventName } = ibPkg;

// Informational TWS codes that are not real errors (market data farm status etc.).
const INFO_CODES = new Set([2104, 2106, 2107, 2108, 2119, 2158, 2100, 2150, 10167, 399]);

const stock = (symbol) => ({ symbol, secType: "STK", exchange: "SMART", currency: "USD" });
const tick = (p) => Math.round(p * 100) / 100;

// Interactive Brokers broker via TWS / IB Gateway socket API.
export class IBBroker extends EventEmitter {
  constructor(cfg, live) {
    super();
    this.cfg = cfg;
    this.live = live;
    this.name = live ? "live" : "paper";
    this.port = live ? cfg.ib.livePort : cfg.ib.paperPort;
    this.connected = false;
    this.reqId = 1000;
    this.nextOrderId = null;
    this.account = cfg.ib.accountId || null;
    this.values = {};
    this.portfolio = {}; // SYM -> position row
    this.orders = {}; // orderId -> order row
    this.dailyPnL = null;
    this.lastError = null;

    this.ib = new IBApi({ host: cfg.ib.host, port: this.port });
    this.wire();
  }

  wire() {
    const ib = this.ib;
    ib.on(EventName.connected, () => { this.connected = true; });
    ib.on(EventName.disconnected, () => { this.connected = false; this.emit("log", "warn", "انقطع الاتصال بـ TWS / IB Gateway"); });
    ib.on(EventName.error, (err, code, reqId) => {
      if (INFO_CODES.has(code)) return;
      const msg = `IB ${code ?? ""}: ${err?.message ?? err}`;
      this.lastError = msg;
      this.emit("log", "error", msg + (reqId > 0 ? ` (req ${reqId})` : ""));
    });
    ib.on(EventName.nextValidId, (id) => { this.nextOrderId = id; });
    ib.on(EventName.managedAccounts, (list) => {
      const accounts = String(list).split(",").filter(Boolean);
      if (!this.account || !accounts.includes(this.account)) this.account = accounts[0];
      this.emit("log", "info", `الحسابات المتاحة: ${accounts.join(", ")} — الحساب المستخدم: ${this.account}`);
      this.subscribeAccount();
    });
    ib.on(EventName.updateAccountValue, (key, value, currency, acct) => {
      // Summary keys (NetLiquidation, TotalCashValue, ...) arrive once, in the account's base currency.
      if (acct !== this.account || currency === "BASE") return;
      this.values[key] = value;
      if (key === "NetLiquidation" && currency) this.baseCurrency = currency;
    });
    ib.on(EventName.updatePortfolio, (contract, position, marketPrice, marketValue, averageCost, unrealizedPNL) => {
      if (contract.secType !== "STK") return;
      if (!position) { delete this.portfolio[contract.symbol]; return; }
      this.portfolio[contract.symbol] = {
        symbol: contract.symbol, qty: position, avgCost: averageCost, marketPrice,
        marketValue, unrealizedPnL: unrealizedPNL,
      };
    });
    ib.on(EventName.pnl, (_reqId, daily) => { this.dailyPnL = Number.isFinite(daily) ? daily : null; });
    ib.on(EventName.openOrder, (orderId, contract, order, state) => {
      this.orders[orderId] = {
        orderId, symbol: contract.symbol, action: order.action, type: order.orderType,
        qty: order.totalQuantity, price: order.lmtPrice || order.auxPrice || null,
        status: state?.status ?? this.orders[orderId]?.status ?? "Submitted",
      };
    });
    ib.on(EventName.orderStatus, (orderId, status) => {
      if (["Filled", "Cancelled", "ApiCancelled", "Inactive"].includes(status)) delete this.orders[orderId];
      else if (this.orders[orderId]) this.orders[orderId].status = status;
    });
    ib.on(EventName.execDetails, (_reqId, contract, ex) => {
      if (contract.secType !== "STK") return;
      this.emit("fill", {
        symbol: contract.symbol, side: ex.side === "BOT" ? "BUY" : "SELL", qty: ex.shares, price: ex.price,
        orderId: ex.orderId, execId: ex.execId, time: new Date().toISOString(),
        // IBKR Pro fixed-rate estimate; exact commission arrives later in commissionReport.
        commission: Math.max(1, ex.shares * 0.005),
      });
    });
  }

  subscribeAccount() {
    this.ib.reqAccountUpdates(true, this.account);
    this.ib.reqPnL(this.reqId++, this.account, "");
    this.ib.reqOpenOrders();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`تعذر الاتصال بـ ${this.cfg.ib.host}:${this.port} — تأكد أن TWS أو IB Gateway يعمل وأن الـ API مفعّل`));
      }, 10000);
      const onId = () => { cleanup(); resolve(); };
      const cleanup = () => { clearTimeout(timer); this.ib.off(EventName.nextValidId, onId); };
      this.ib.on(EventName.nextValidId, onId);
      try {
        this.ib.connect(this.cfg.ib.clientId);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  }

  async disconnect() {
    try { this.ib.disconnect(); } catch { /* already closed */ }
    this.connected = false;
  }

  isConnected() { return this.connected && this.nextOrderId != null; }

  async getAccount() {
    const v = (k) => (this.values[k] !== undefined ? Number(this.values[k]) : null);
    return {
      accountId: this.account,
      currency: this.baseCurrency || "USD",
      netLiquidation: v("NetLiquidation"),
      cash: v("TotalCashValue"),
      buyingPower: v("BuyingPower"),
      grossPositionValue: v("GrossPositionValue"),
      unrealizedPnL: v("UnrealizedPnL"),
      realizedPnL: v("RealizedPnL"),
      dailyPnL: this.dailyPnL,
      accountType: this.values.AccountType || null,
    };
  }

  async getPositions() {
    return Object.values(this.portfolio);
  }

  async getOpenOrders() {
    return Object.values(this.orders);
  }

  getBars(symbol) {
    return new Promise((resolve, reject) => {
      const reqId = this.reqId++;
      const bars = [];
      const timer = setTimeout(() => { cleanup(); reject(new Error(`انتهت مهلة البيانات التاريخية لـ ${symbol}`)); }, 20000);
      const onBar = (id, time, open, high, low, close, volume) => {
        if (id !== reqId) return;
        if (String(time).startsWith("finished")) { cleanup(); resolve(bars); return; }
        if (close > 0) bars.push({ time, open, high, low, close, volume });
      };
      const onEnd = (id) => { if (id === reqId) { cleanup(); resolve(bars); } };
      const onErr = (err, code, id) => {
        if (id !== reqId) return;
        cleanup();
        reject(new Error(`${symbol}: IB ${code} ${err?.message ?? err}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.ib.off(EventName.historicalData, onBar);
        this.ib.off(EventName.historicalDataEnd, onEnd);
        this.ib.off(EventName.error, onErr);
      };
      this.ib.on(EventName.historicalData, onBar);
      if (EventName.historicalDataEnd) this.ib.on(EventName.historicalDataEnd, onEnd);
      this.ib.on(EventName.error, onErr);
      this.ib.reqHistoricalData(reqId, stock(symbol), "", "3 D", this.cfg.strategy.barSize, "TRADES", 1, 1, false);
    });
  }

  takeOrderId() {
    if (this.nextOrderId == null) throw new Error("لا يوجد معرّف أوامر من IB بعد");
    return this.nextOrderId++;
  }

  // Marketable limit entry + take-profit limit + stop-loss stop, linked as a bracket (OCA children).
  async placeBracket({ symbol, qty, entryPrice, takeProfit, stopLoss }) {
    const parentId = this.takeOrderId();
    const tpId = this.takeOrderId();
    const slId = this.takeOrderId();
    const contract = stock(symbol);
    const common = { totalQuantity: qty, tif: "DAY", outsideRth: false, account: this.account };
    this.ib.placeOrder(parentId, contract, {
      ...common, orderId: parentId, action: "BUY", orderType: "LMT", lmtPrice: tick(entryPrice * 1.001), transmit: false,
    });
    this.ib.placeOrder(tpId, contract, {
      ...common, orderId: tpId, parentId, action: "SELL", orderType: "LMT", lmtPrice: tick(takeProfit), transmit: false,
    });
    this.ib.placeOrder(slId, contract, {
      ...common, orderId: slId, parentId, action: "SELL", orderType: "STP", auxPrice: tick(stopLoss), transmit: true,
    });
    this.orders[parentId] = { orderId: parentId, symbol, action: "BUY", type: "LMT", qty, price: tick(entryPrice * 1.001), status: "PendingSubmit" };
    return parentId;
  }

  async closePosition(symbol) {
    for (const o of Object.values(this.orders)) {
      if (o.symbol === symbol) this.ib.cancelOrder(o.orderId);
    }
    const pos = this.portfolio[symbol];
    if (!pos || pos.qty <= 0) return;
    const id = this.takeOrderId();
    this.ib.placeOrder(id, stock(symbol), {
      orderId: id, action: "SELL", orderType: "MKT", totalQuantity: pos.qty, tif: "DAY", transmit: true, account: this.account,
    });
  }

  async cancelAll() {
    this.ib.reqGlobalCancel();
    this.orders = {};
  }
}
