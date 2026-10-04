import zlib from "node:zlib";
import { handler, requireSession, redisEval, KEYS, HttpError } from "./_lib.js";

// Read-only view of the bot's settings; changing settings or mode is only allowed on the PC itself.
export default handler(async (req) => {
  requireSession(req);
  if (req.method !== "GET") throw new HttpError(403, "تغيير الإعدادات ووضع التداول متاح فقط من المنصة على جهازك (لأسباب أمنية)");
  const snap = await redisEval("return redis.call('GET', KEYS[1]) or ''", [KEYS.snap]);
  if (!snap) throw new HttpError(503, "لا توجد بيانات من جهازك بعد");
  return JSON.parse(zlib.gunzipSync(Buffer.from(snap, "base64")).toString("utf8")).config;
});
