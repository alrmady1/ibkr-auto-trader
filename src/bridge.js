import zlib from "node:zlib";
import { marketStatus } from "./market.js";

// Pushes dashboard snapshots from this PC to the online (Vercel) dashboard and runs the
// control commands queued there. Outbound HTTPS only — nothing on this PC is exposed to the internet.
export class CloudBridge {
  constructor(engine, getCfg, publicConfig) {
    this.engine = engine;
    this.getCfg = getCfg;
    this.publicConfig = publicConfig;
    this.viewerActive = false;
    this.lastOk = null;
    this.lastError = null;
    this.lastErrorLogged = 0;
  }

  start() {
    this.schedule(2000);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
  }

  // Fast while someone is watching or the bot is trading; slow otherwise to stay within free tiers.
  interval() {
    if (this.viewerActive) return 4000;
    if (this.engine.running && marketStatus().isOpen) return 10000;
    return 20000;
  }

  async tick() {
    const c = this.getCfg().cloud;
    if (!c?.enabled || !c.url || !c.token) return this.schedule(10000);
    try {
      const snapshot = zlib.gzipSync(JSON.stringify({ ...this.engine.dashboard(), config: this.publicConfig() })).toString("base64");
      const res = await fetch(new URL("/api/bridge", c.url), {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot }),
        signal: AbortSignal.timeout(15000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (!this.lastOk || this.lastError) this.engine.log("info", "☁ تم الربط مع المنصة السحابية");
      this.lastOk = new Date().toISOString();
      this.lastError = null;
      this.viewerActive = json.viewerActive;
      for (const cmd of json.commands || []) await this.run(cmd);
    } catch (e) {
      this.lastError = e.message;
      if (Date.now() - this.lastErrorLogged > 600000) {
        this.engine.log("warn", `☁ تعذر الاتصال بالمنصة السحابية: ${e.message}`);
        this.lastErrorLogged = Date.now();
      }
    }
    this.schedule(this.interval());
  }

  async run(cmd) {
    // Ignore stale commands (e.g. queued while this PC was off) so nothing fires unexpectedly later.
    if (Date.now() - cmd.at > 120000) {
      this.engine.log("warn", `☁ تم تجاهل أمر قديم من المنصة السحابية: ${cmd.type}`);
      return;
    }
    const e = this.engine;
    try {
      if (cmd.type === "start") e.startBot();
      else if (cmd.type === "stop") e.stopBot();
      else if (cmd.type === "kill") await e.kill();
      else if (cmd.type === "reset-halt") e.resetHalt();
      else if (cmd.type === "close") await e.closeOne(cmd.symbol);
      e.log("info", `☁ نُفّذ أمر عن بُعد: ${cmd.type}${cmd.symbol ? ` ${cmd.symbol}` : ""}`);
    } catch (err) {
      e.log("error", `☁ فشل أمر عن بُعد (${cmd.type}): ${err.message}`);
    }
  }

  status() {
    const c = this.getCfg().cloud;
    return { enabled: !!c?.enabled, url: c?.url || "", lastOk: this.lastOk, lastError: this.lastError };
  }
}
