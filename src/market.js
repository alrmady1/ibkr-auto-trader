// US equity market calendar (NYSE/Nasdaq regular session), evaluated in America/New_York.

const HOLIDAYS = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const EARLY_CLOSE = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]); // 13:00 ET

function partsIn(tz, date) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
    weekday: p.weekday,
    hhmm: `${String(Number(p.hour) % 24).padStart(2, "0")}:${p.minute}`,
  };
}

export const nyDate = (d = new Date()) => partsIn("America/New_York", d).date;

export function fmtRiyadh(d) {
  return new Intl.DateTimeFormat("ar-SA-u-nu-latn", {
    timeZone: "Asia/Riyadh", weekday: "long", hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(d);
}

export function isTradingDay(dateStr, weekday) {
  return !["Sat", "Sun"].includes(weekday) && !HOLIDAYS.has(dateStr);
}

export function marketStatus(now = new Date()) {
  const ny = partsIn("America/New_York", now);
  const open = 9 * 60 + 30;
  const close = EARLY_CLOSE.has(ny.date) ? 13 * 60 : 16 * 60;
  const tradingDay = isTradingDay(ny.date, ny.weekday);
  const isOpen = tradingDay && ny.minutes >= open && ny.minutes < close;

  let session = "closed";
  if (tradingDay && ny.minutes >= 4 * 60 && ny.minutes < open) session = "pre";
  else if (isOpen) session = "regular";
  else if (tradingDay && ny.minutes >= close && ny.minutes < 20 * 60) session = "post";

  // Next regular open (search forward minute-accurate by day).
  let nextOpen = null;
  if (!isOpen) {
    for (let i = 0; i < 10; i++) {
      const probe = new Date(now.getTime() + i * 86400000);
      const p = partsIn("America/New_York", probe);
      if (!isTradingDay(p.date, p.weekday)) continue;
      if (i === 0 && ny.minutes >= open) continue;
      // Shift probe to 09:30 NY on that date.
      nextOpen = new Date(probe.getTime() + (open - p.minutes) * 60000 - probe.getSeconds() * 1000);
      break;
    }
  }

  return {
    isOpen,
    session,
    nyDate: ny.date,
    nyTime: ny.hhmm,
    riyadhTime: partsIn("Asia/Riyadh", now).hhmm,
    minutesSinceOpen: isOpen ? ny.minutes - open : null,
    minutesToClose: isOpen ? close - ny.minutes : null,
    nextOpen: nextOpen ? nextOpen.toISOString() : null,
    nextOpenRiyadh: nextOpen ? fmtRiyadh(nextOpen) : null,
    earlyClose: EARLY_CLOSE.has(ny.date),
  };
}
