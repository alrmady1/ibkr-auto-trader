// Shared helpers for the Vercel functions (files starting with "_" are not exposed as routes).
import crypto from "node:crypto";

// Vercel's Upstash integration may add a custom prefix (e.g. "kv_KV_REST_API_URL"), so match by suffix.
const envBySuffix = (...suffixes) => {
  for (const s of suffixes) {
    const key = Object.keys(process.env).find((k) => k === s || k.endsWith(`_${s}`));
    if (key && process.env[key]) return process.env[key];
  }
  return undefined;
};
const REDIS_URL = envBySuffix("KV_REST_API_URL", "UPSTASH_REDIS_REST_URL");
const REDIS_TOKEN = envBySuffix("KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN");
const SESSION_DAYS = 7;

export const KEYS = { snap: "ibkr:snap", pushedAt: "ibkr:pushedAt", queue: "ibkr:cmds", lastView: "ibkr:lastView" };

// Runs a Lua script on Upstash Redis (one billed command per call).
export async function redisEval(script, keys = [], args = []) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new HttpError(500, "قاعدة البيانات (Upstash Redis) غير مربوطة بالمشروع على Vercel");
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(["EVAL", script, String(keys.length), ...keys, ...args.map(String)]),
  });
  const json = await res.json();
  if (json.error) throw new HttpError(500, `Redis: ${json.error}`);
  return json.result;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function handler(fn) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.status(200).json(out ?? { ok: true });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  };
}

export function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const y = crypto.createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(x, y);
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new HttpError(500, "SESSION_SECRET غير مضبوط على Vercel");
  return s;
}

const sign = (v) => crypto.createHmac("sha256", secret()).update(v).digest("base64url");

export function sessionCookie() {
  const exp = String(Date.now() + SESSION_DAYS * 86400000);
  return `sess=${exp}.${sign(exp)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

export const clearCookie = "sess=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";

export function requireSession(req) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith("sess="))?.slice(5) || "";
  const [exp, sig] = raw.split(".");
  if (!exp || !sig || !safeEqual(sig, sign(exp)) || Number(exp) < Date.now()) {
    throw new HttpError(401, "يجب تسجيل الدخول");
  }
}

// The local bot authenticates with a shared bearer token.
export function requireBridge(req) {
  const expected = process.env.BRIDGE_TOKEN;
  if (!expected || expected.length < 24) throw new HttpError(500, "BRIDGE_TOKEN غير مضبوط على Vercel");
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(got, expected)) throw new HttpError(401, "رمز الربط غير صحيح");
}

export function requireMethod(req, ...methods) {
  if (!methods.includes(req.method)) throw new HttpError(405, "Method not allowed");
}

// JSON body only — together with SameSite=Strict cookies this blocks cross-site form posts.
export function requireJson(req) {
  if (!String(req.headers["content-type"] || "").includes("application/json")) throw new HttpError(415, "JSON required");
}
