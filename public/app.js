const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let data = null;
let currency = "USD";
const charts = {};

// ---------- formatting ----------
const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const money = (v) => (v == null ? "—" : `${v < 0 ? "-" : ""}$${fmt(Math.abs(v))}`);
const signed = (v) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "-" : ""}$${fmt(Math.abs(v))}`);
const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${fmt(v)}%`);
const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Riyadh time as "DD/MM HH:MM" (plain digits so it renders cleanly inside LTR number cells).
const time = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 3500);
}

async function api(path, method = "GET", body) {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("يجب تسجيل الدخول");
  }
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "خطأ");
  return json;
}

// ---------- tabs ----------
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.id === `tab-${b.dataset.tab}`));
  try { localStorage.setItem("tab", b.dataset.tab); } catch { /* storage unavailable */ }
  if (data) render();
});
try {
  const saved = localStorage.getItem("tab");
  if (saved) document.querySelector(`.tabs button[data-tab="${saved}"]`)?.click();
} catch { /* storage unavailable */ }

// ---------- header ----------
function renderHeader(s) {
  const mb = $("modeBadge");
  mb.className = `badge ${s.mode}`;
  mb.textContent = s.modeLabel;

  const cb = $("connBadge");
  cb.className = `badge ${s.connected ? "ok" : "bad"}`;
  cb.querySelector("span").textContent = s.connected ? "متصل" : "غير متصل";

  const m = s.market;
  const label = { regular: "السوق الأمريكي مفتوح", pre: "ما قبل الافتتاح", post: "ما بعد الإغلاق", closed: "السوق مغلق" }[m.session];
  const mk = $("marketBadge");
  mk.className = `badge ${m.isOpen ? "ok" : ""}`;
  mk.textContent = m.isOpen ? `${label} · يغلق بعد ${m.minutesToClose} د` : label;
  $("clock").textContent = `الرياض ${m.riyadhTime} · نيويورك ${m.nyTime}`;

  $("btnStart").classList.toggle("running", s.running);
  $("btnStart").textContent = s.running ? "● البوت يعمل" : "▶ تشغيل البوت";

  const alerts = [];
  const cloud = data.cloud;
  if (cloud && cloud.ageSec > 150) alerts.push(["err", `⚠ جهازك غير متصل منذ ${Math.round(cloud.ageSec / 60)} دقيقة — البيانات المعروضة قديمة والأوامر لن تُنفَّذ حتى يعود الاتصال.`]);
  if (cloud) alerts.push(["info", `☁ عرض عن بُعد — آخر تحديث من جهازك قبل ${cloud.ageSec} ثانية. الأوامر تصل للبوت خلال ثوانٍ.`]);
  if (data.bridge?.enabled && data.bridge.lastError) alerts.push(["warn", `☁ الربط السحابي: ${esc(data.bridge.lastError)}`]);
  if (s.mode === "live") alerts.push(["err", "⚠ وضع التداول الحقيقي مفعّل — الأوامر تُنفَّذ بأموال حقيقية."]);
  if (s.halted) alerts.push(["err", `⛔ ${s.halted} <button class="btn sm" id="btnReset">إعادة التفعيل</button>`]);
  if (s.blocked) alerts.push(["warn", `⏳ دخول صفقات جديدة متوقف مؤقتاً: ${s.blocked}`]);
  if (!s.connected && s.mode !== "sim") alerts.push(["err", "غير متصل بـ TWS / IB Gateway. شغّل البرنامج وسجّل الدخول وتأكد من تفعيل الـ API (راجع ملف README)."]);
  if (s.lastError && s.mode !== "sim") alerts.push(["warn", `آخر رسالة من IB: ${esc(s.lastError)}`]);
  if (s.running && !m.isOpen && !s.ignoreMarketHours) alerts.push(["info", `البوت يعمل وسيبدأ التداول عند افتتاح السوق${m.nextOpenRiyadh ? ` (${m.nextOpenRiyadh} بتوقيت الرياض)` : ""}.`]);
  if (s.ignoreMarketHours) alerts.push(["info", "وضع المحاكاة: الأسعار افتراضية وتتحرك بسرعة لتجربة البوت في أي وقت."]);
  $("alerts").innerHTML = alerts.map(([k, t]) => `<div class="alert ${k}">${t}</div>`).join("");
  $("btnReset")?.addEventListener("click", () => action("/api/bot/reset-halt", "تمت إعادة التفعيل"));
}

// ---------- dashboard ----------
function renderKpis() {
  const m = data.metrics, a = data.account || {};
  const invested = a.grossPositionValue;
  const cards = [
    ["صافي قيمة الحساب", money(m.equity), a.accountId ? `الحساب ${esc(a.accountId)}` : ""],
    ["رأس المال المبدئي", money(m.initialCapital), ""],
    ["إجمالي الربح / الخسارة", `<span class="${cls(m.totalPnL)}">${signed(m.totalPnL)}</span>`, ""],
    ["نسبة النمو", `<span class="${cls(m.growthPct)}">${pct(m.growthPct)}</span>`, "منذ البداية"],
    ["ربح اليوم", `<span class="${cls(m.todayPnL)}">${signed(m.todayPnL)}</span>`, m.todayPct != null ? pct(m.todayPct) : ""],
    ["النقد المتاح", money(a.cash), a.buyingPower != null ? `القوة الشرائية ${money(a.buyingPower)}` : ""],
    ["قيمة الاستثمارات", money(invested), `${data.positions.length} مركز مفتوح`],
    ["ربح غير محقق", `<span class="${cls(a.unrealizedPnL)}">${signed(a.unrealizedPnL)}</span>`, ""],
    ["نسبة الصفقات الرابحة", m.winRate == null ? "—" : `${fmt(m.winRate, 1)}%`, `${m.tradeCount} صفقة مغلقة`],
    ["معامل الربح", m.profitFactor == null ? "—" : fmt(m.profitFactor), "إجمالي الأرباح ÷ الخسائر"],
    ["أقصى تراجع", `<span class="down">${fmt(m.maxDrawdownPct)}%</span>`, "من أعلى قمة"],
    ["أيام رابحة / خاسرة", `<span class="up">${m.profitableDays}</span> / <span class="down">${m.losingDays}</span>`, "آخر 60 يوماً"],
  ];
  $("kpis").innerHTML = cards.map(([l, v, s]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("");
}

function baseChartOpts() {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { rtl: true, intersect: false, mode: "index" } },
    scales: {
      x: { ticks: { color: css("--muted"), maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } },
      y: { position: "right", ticks: { color: css("--muted") }, grid: { color: css("--line") } },
    },
  };
}

function upsertChart(key, canvasId, config) {
  if (!window.Chart) return;
  if (charts[key]) {
    charts[key].data = config.data;
    charts[key].update("none");
  } else {
    charts[key] = new Chart($(canvasId), config);
  }
}

function renderCharts() {
  const eq = data.equity;
  const up = eq.length > 1 && eq.at(-1).v >= eq[0].v;
  const color = up ? css("--up") : css("--down");
  upsertChart("eq", "eqChart", {
    type: "line",
    data: {
      labels: eq.map((p) => time(p.t)),
      datasets: [{ data: eq.map((p) => p.v), borderColor: color, borderWidth: 2, pointRadius: 0, fill: true, backgroundColor: color + "22", tension: 0.2 }],
    },
    options: baseChartOpts(),
  });
  $("eqRange").textContent = eq.length ? `${time(eq[0].t)} ← ${time(eq.at(-1).t)}` : "";

  const d = data.metrics.daily;
  upsertChart("daily", "dailyChart", {
    type: "bar",
    data: {
      labels: d.map((x) => x.date.slice(5)),
      datasets: [{ data: d.map((x) => x.pnl), backgroundColor: d.map((x) => (x.pnl >= 0 ? css("--up") : css("--down"))), borderRadius: 4, maxBarThickness: 28 }],
    },
    options: baseChartOpts(),
  });
}

function renderRank() {
  const st = data.symbolStats;
  const max = Math.max(1, ...st.map((s) => Math.abs(s.total)));
  const row = (s) => `<div class="row"><span class="sym">${esc(s.symbol)}</span>
    <div class="bar"><i style="width:${(Math.abs(s.total) / max) * 100}%;background:${s.total >= 0 ? css("--up") : css("--down")}"></i></div>
    <span class="val num ${cls(s.total)}">${signed(s.total)}</span></div>`;
  const best = st.filter((s) => s.total > 0).slice(0, 5);
  const worst = st.filter((s) => s.total <= 0).slice(-5).reverse();
  $("bestList").innerHTML = best.length ? best.map(row).join("") : `<div class="empty">لا توجد أرباح بعد</div>`;
  $("worstList").innerHTML = worst.length ? worst.map(row).join("") : `<div class="empty">لا توجد خسائر بعد</div>`;
}

// ---------- tables ----------
function table(id, head, rows, empty) {
  $(id).innerHTML = `<thead><tr>${head.map(([t, n]) => `<th class="${n ? "n" : ""}">${t}</th>`).join("")}</tr></thead>
    <tbody>${rows.length ? rows.join("") : `<tr><td class="empty" colspan="${head.length}">${empty}</td></tr>`}</tbody>`;
}

function renderPortfolio() {
  const pos = data.positions;
  $("posCount").textContent = `${pos.length} مركز`;
  table("posTable",
    [["السهم"], ["الكمية", 1], ["متوسط التكلفة", 1], ["السعر الحالي", 1], ["القيمة", 1], ["ربح/خسارة", 1], ["%", 1], [""]],
    pos.map((p) => {
      const pc = p.avgCost ? ((p.marketPrice - p.avgCost) / p.avgCost) * 100 : null;
      return `<tr><td class="sym">${esc(p.symbol)}</td><td class="n">${p.qty}</td><td class="n">${money(p.avgCost)}</td>
        <td class="n">${money(p.marketPrice)}</td><td class="n">${money(p.marketValue)}</td>
        <td class="n ${cls(p.unrealizedPnL)}">${signed(p.unrealizedPnL)}</td><td class="n ${cls(pc)}">${pct(pc)}</td>
        <td><button class="btn sm danger" data-close="${esc(p.symbol)}">إغلاق</button></td></tr>`;
    }), "لا توجد مراكز مفتوحة");

  const a = data.account || {};
  const labels = [...pos.map((p) => p.symbol), "نقد"];
  const values = [...pos.map((p) => p.marketValue), Math.max(0, a.cash || 0)];
  const palette = ["#2463eb", "#0e9f6e", "#e8a317", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#64748b"];
  upsertChart("alloc", "allocChart", {
    type: "doughnut",
    data: { labels, datasets: [{ data: values, backgroundColor: labels.map((_, i) => (i === labels.length - 1 ? css("--line") : palette[i % palette.length])), borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, cutout: "62%", plugins: { legend: { position: "bottom", rtl: true, labels: { color: css("--text"), boxWidth: 12 } } } },
  });

  const typeLbl = { LMT: "حد (جني ربح)", STP: "وقف خسارة", MKT: "سوق" };
  table("ordTable",
    [["رقم"], ["السهم"], ["النوع"], ["الاتجاه"], ["الكمية", 1], ["السعر", 1], ["الحالة"]],
    data.orders.map((o) => `<tr><td class="n">${o.orderId}</td><td class="sym">${esc(o.symbol)}</td>
      <td>${o.action === "BUY" ? "دخول" : typeLbl[o.type] || o.type}</td>
      <td><span class="pill ${o.action === "BUY" ? "buy" : "sell"}">${o.action === "BUY" ? "شراء" : "بيع"}</span></td>
      <td class="n">${o.qty}</td><td class="n">${money(o.price)}</td><td>${esc(o.status)}</td></tr>`),
    "لا توجد أوامر معلّقة");

  table("symTable",
    [["السهم"], ["عدد الصفقات", 1], ["نسبة الربح", 1], ["ربح محقق", 1], ["غير محقق", 1], ["الإجمالي", 1]],
    data.symbolStats.map((s) => `<tr><td class="sym">${esc(s.symbol)}</td><td class="n">${s.trades}</td>
      <td class="n">${s.winRate == null ? "—" : fmt(s.winRate, 0) + "%"}</td><td class="n ${cls(s.pnl)}">${signed(s.pnl)}</td>
      <td class="n ${cls(s.unrealized)}">${s.unrealized == null ? "—" : signed(s.unrealized)}</td>
      <td class="n ${cls(s.total)}"><b>${signed(s.total)}</b></td></tr>`),
    "لا توجد بيانات بعد");
}

function renderSignals() {
  const lbl = { BUY: ["buy", "شراء"], SELL: ["sell", "خروج"], HOLD: ["hold", "انتظار"] };
  const held = new Set(data.positions.map((p) => p.symbol));
  table("sigTable",
    [["السهم"], ["السعر", 1], ["RSI", 1], ["متوسط الاتجاه", 1], ["الإشارة"], ["السبب"], ["الحالة"]],
    data.signals.map((s) => {
      const [c, t] = lbl[s.action] || lbl.HOLD;
      return `<tr><td class="sym">${esc(s.symbol)}</td><td class="n">${money(s.price)}</td>
        <td class="n">${s.indicators?.rsi ?? "—"}</td><td class="n">${money(s.indicators?.trendEma)}</td>
        <td><span class="pill ${c}">${t}</span></td><td class="reason">${esc(s.reason)}</td>
        <td>${held.has(s.symbol) ? '<span class="pill buy">في المحفظة</span>' : ""}</td></tr>`;
    }), "أضف أسهماً من الإعدادات");
}

function renderTrades() {
  table("tradeTable",
    [["السهم"], ["الكمية", 1], ["سعر الدخول", 1], ["سعر الخروج", 1], ["الربح/الخسارة", 1], ["%", 1], ["الدخول"], ["الخروج"]],
    data.trades.map((t) => `<tr><td class="sym">${esc(t.symbol)}</td><td class="n">${t.qty}</td>
      <td class="n">${money(t.entryPrice)}</td><td class="n">${money(t.exitPrice)}</td>
      <td class="n ${cls(t.pnl)}"><b>${signed(t.pnl)}</b></td><td class="n ${cls(t.pnlPct)}">${pct(t.pnlPct)}</td>
      <td class="num">${time(t.entryTime)}</td><td class="num">${time(t.exitTime)}</td></tr>`),
    "لم تُغلق أي صفقة بعد");
}

function renderLog() {
  $("logList").innerHTML = data.logs.map((l) => `<div class="e"><span class="t">${time(l.time)}</span><span class="${l.level}">${esc(l.msg)}</span></div>`).join("")
    || `<div class="empty">لا يوجد نشاط</div>`;
}

function render() {
  renderHeader(data.status);
  const active = document.querySelector(".tab.active")?.id;
  if (active === "tab-dash") { renderKpis(); renderCharts(); renderRank(); }
  if (active === "tab-portfolio") renderPortfolio();
  if (active === "tab-signals") renderSignals();
  if (active === "tab-trades") renderTrades();
  if (active === "tab-log") renderLog();
}

async function refresh() {
  try {
    data = await api("/api/dashboard");
    currency = data.account?.currency || "USD";
    if (data.cloud) enterCloudMode();
    else if (data.bridge) $("cloudState").textContent = data.bridge.enabled ? (data.bridge.lastOk && !data.bridge.lastError ? "متصل ✓" : "غير متصل") : "معطّل";
    render();
  } catch (e) {
    $("alerts").innerHTML = `<div class="alert err">${esc(e.message)}</div>`;
  }
}

// ---------- online (Vercel) mode ----------
let cloudMode = false;
function enterCloudMode() {
  if (cloudMode) return;
  cloudMode = true;
  $("btnLogout").hidden = false;
  $("cloudCard").hidden = true;
  document.querySelectorAll("#tab-settings input, #tab-settings select, #tab-settings textarea, #btnSave, #btnMode").forEach((el) => (el.disabled = true));
  const note = document.createElement("div");
  note.className = "alert info";
  note.textContent = "الإعدادات للعرض فقط عن بُعد. تغيير الإعدادات أو وضع التداول متاح فقط من المنصة على جهازك لأسباب أمنية.";
  $("tab-settings").prepend(note);
}
$("btnLogout").onclick = async () => {
  await fetch("/api/logout", { method: "POST" });
  location.href = "/login.html";
};

// ---------- actions ----------
async function action(path, ok, body) {
  try {
    await api(path, "POST", body ?? {});
    toast(cloudMode ? `${ok} — أُرسل الأمر إلى جهازك` : ok);
    refresh();
  } catch (e) {
    toast(e.message);
  }
}

$("btnStart").onclick = () => action("/api/bot/start", "تم تشغيل البوت");
$("btnStop").onclick = () => action("/api/bot/stop", "تم إيقاف البوت");
$("btnKill").onclick = () => {
  if (confirm("إيقاف طارئ: سيتم إلغاء كل الأوامر وبيع كل المراكز فوراً بسعر السوق. متابعة؟")) action("/api/bot/kill", "تم الإيقاف الطارئ");
};
$("posTable").addEventListener("click", (e) => {
  const sym = e.target.dataset?.close;
  if (sym && confirm(`بيع كامل مركز ${sym} بسعر السوق؟`)) action(`/api/positions/${encodeURIComponent(sym)}/close`, `تم إرسال أمر إغلاق ${sym}`);
});

// ---------- settings ----------
async function loadSettings() {
  const c = await api("/api/config");
  document.querySelector(`input[name="mode"][value="${c.mode}"]`).checked = true;
  $("watchlist").value = c.watchlist.join(", ");
  $("stratSel").value = c.strategy.name;
  $("rsiBuy").value = c.strategy.rsiBuy; $("rsiSell").value = c.strategy.rsiSell;
  $("initCap").value = c.initialCapital ?? "";
  const r = c.risk;
  $("tp").value = r.takeProfitPct; $("sl").value = r.stopLossPct; $("maxPos").value = r.maxPositionPct;
  $("maxOpen").value = r.maxOpenPositions; $("maxTrades").value = r.maxTradesPerDay; $("dailyLoss").value = r.dailyLossLimitPct;
  $("flatten").value = r.flattenMinutesBeforeClose; $("useMargin").checked = r.useMargin; $("pdt").checked = r.pdtProtection;
  $("stratName").textContent = $("stratSel").selectedOptions[0].textContent;
  if (c.cloud) {
    $("cloudUrl").value = c.cloud.url || "";
    $("cloudEnabled").checked = c.cloud.enabled;
    $("cloudToken").placeholder = c.cloud.hasToken ? "محفوظ ✓ — اتركه فارغاً للإبقاء عليه" : "الصق رمز الربط هنا";
  }
  if (c.ib) {
    $("ibHost").value = c.ib.host; $("ibPaperPort").value = c.ib.paperPort; $("ibLivePort").value = c.ib.livePort;
    $("ibClientId").value = c.ib.clientId; $("ibAccount").value = c.ib.accountId || "";
  }
}

$("btnSave").onclick = async () => {
  try {
    await api("/api/config", "PUT", {
      watchlist: $("watchlist").value,
      initialCapital: $("initCap").value === "" ? null : Number($("initCap").value),
      strategy: { name: $("stratSel").value, rsiBuy: $("rsiBuy").value, rsiSell: $("rsiSell").value },
      risk: {
        takeProfitPct: $("tp").value, stopLossPct: $("sl").value, maxPositionPct: $("maxPos").value,
        maxOpenPositions: $("maxOpen").value, maxTradesPerDay: $("maxTrades").value, dailyLossLimitPct: $("dailyLoss").value,
        flattenMinutesBeforeClose: $("flatten").value, useMargin: $("useMargin").checked, pdtProtection: $("pdt").checked,
      },
      ib: { host: $("ibHost").value, paperPort: $("ibPaperPort").value, livePort: $("ibLivePort").value, clientId: $("ibClientId").value, accountId: $("ibAccount").value },
    });
    toast("تم حفظ الإعدادات");
    loadSettings();
  } catch (e) {
    toast(e.message);
  }
};

$("btnMode").onclick = async () => {
  const mode = document.querySelector('input[name="mode"]:checked')?.value;
  let confirmLive;
  if (mode === "live") {
    confirmLive = prompt("تحذير: سيتم التداول بأموال حقيقية.\nللتأكيد اكتب LIVE بالأحرف الإنجليزية:");
    if (confirmLive !== "LIVE") return toast("تم الإلغاء");
  }
  toast("جارٍ التبديل والاتصال…");
  try {
    await api("/api/mode", "POST", { mode, confirmLive });
    Object.values(charts).forEach((c) => c.destroy());
    for (const k of Object.keys(charts)) delete charts[k];
    toast("تم تغيير الوضع");
    refresh();
  } catch (e) {
    toast(e.message);
  }
};

$("btnCloud").onclick = async () => {
  try {
    await api("/api/config", "PUT", { cloud: { url: $("cloudUrl").value, token: $("cloudToken").value, enabled: $("cloudEnabled").checked } });
    $("cloudToken").value = "";
    toast("تم حفظ الربط السحابي");
    loadSettings();
  } catch (e) {
    toast(e.message);
  }
};

loadSettings().catch(() => {});
refresh();
setInterval(refresh, 3000);
