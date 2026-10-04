import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, applySettings } from "./src/config.js";
import { Engine } from "./src/engine.js";
import { CloudBridge } from "./src/bridge.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let cfg = loadConfig();
const engine = new Engine(cfg);

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, "public")));

const wrap = (fn) => async (req, res) => {
  try {
    res.json((await fn(req)) ?? { ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

// Settings safe to share with the online dashboard (no connection details or tokens).
const sharedConfig = () => ({
  mode: cfg.mode, watchlist: cfg.watchlist, strategy: cfg.strategy,
  risk: cfg.risk, initialCapital: cfg.initialCapital, sim: cfg.sim,
});
const publicConfig = () => ({
  ...sharedConfig(), ib: cfg.ib,
  cloud: { enabled: cfg.cloud.enabled, url: cfg.cloud.url, hasToken: Boolean(cfg.cloud.token) },
});
const bridge = new CloudBridge(engine, () => cfg, sharedConfig);

app.get("/api/dashboard", wrap(() => ({ ...engine.dashboard(), bridge: bridge.status() })));
app.get("/api/config", wrap(() => publicConfig()));

app.put("/api/config", wrap((req) => {
  cfg = applySettings(cfg, req.body || {});
  saveConfig(cfg);
  engine.updateConfig(cfg);
  if (req.body?.initialCapital !== undefined) engine.state.initialCapital = cfg.initialCapital;
  engine.log("info", "تم حفظ الإعدادات");
  return publicConfig();
}));

app.post("/api/mode", wrap(async (req) => {
  const { mode, confirmLive } = req.body || {};
  if (!["sim", "paper", "live"].includes(mode)) throw new Error("وضع غير صالح");
  if (mode === "live" && confirmLive !== "LIVE") throw new Error("يجب تأكيد التداول الحقيقي بكتابة LIVE");
  cfg = { ...cfg, mode };
  saveConfig(cfg);
  await engine.switchMode(cfg);
  return publicConfig();
}));

app.post("/api/bot/start", wrap(() => engine.startBot()));
app.post("/api/bot/stop", wrap(() => engine.stopBot()));
app.post("/api/bot/kill", wrap(() => engine.kill()));
app.post("/api/bot/reset-halt", wrap(() => engine.resetHalt()));
app.post("/api/positions/:symbol/close", wrap((req) => engine.closeOne(String(req.params.symbol).toUpperCase())));

await engine.start();
bridge.start();

// Bound to localhost only: the dashboard controls real money and has no login.
app.listen(cfg.port, "127.0.0.1", () => {
  console.log(`\n  منصة التداول الآلي تعمل على: http://localhost:${cfg.port}\n  الوضع الحالي: ${engine.modeLabel()}\n`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await engine.stop();
    process.exit(0);
  });
}
