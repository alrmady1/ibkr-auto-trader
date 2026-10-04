import zlib from "node:zlib";
import { handler, requireSession, requireMethod, redisEval, KEYS, HttpError } from "./_lib.js";

const SCRIPT = `
redis.call('SET', KEYS[3], ARGV[1], 'EX', 600)
return {redis.call('GET', KEYS[1]) or '', redis.call('GET', KEYS[2]) or ''}`;

export default handler(async (req) => {
  requireMethod(req, "GET");
  requireSession(req);
  const [snap, pushedAt] = await redisEval(SCRIPT, [KEYS.snap, KEYS.pushedAt, KEYS.lastView], [Date.now()]);
  if (!snap) throw new HttpError(503, "لم يتصل البوت من جهازك بعد — شغّل المنصة على جهازك وفعّل الربط السحابي من الإعدادات");

  const data = JSON.parse(zlib.gunzipSync(Buffer.from(snap, "base64")).toString("utf8"));
  delete data.config;
  data.cloud = { pushedAt: Number(pushedAt), ageSec: Math.round((Date.now() - Number(pushedAt)) / 1000) };
  return data;
});
