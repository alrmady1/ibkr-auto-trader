import { handler, requireMethod, requireJson, redisEval, safeEqual, sessionCookie, HttpError } from "./_lib.js";

// Max 8 attempts per IP per 15 minutes.
const LIMIT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], 900) end
return n`;

export default handler(async (req, res) => {
  requireMethod(req, "POST");
  requireJson(req);
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected || expected.length < 8) throw new HttpError(500, "DASHBOARD_PASSWORD غير مضبوط على Vercel");

  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const attempts = await redisEval(LIMIT, [`ibkr:login:${ip}`]);
  if (attempts > 8) throw new HttpError(429, "محاولات كثيرة — حاول بعد 15 دقيقة");

  if (!safeEqual(req.body?.password, expected)) throw new HttpError(401, "كلمة المرور غير صحيحة");
  res.setHeader("Set-Cookie", sessionCookie());
  return { ok: true };
});
