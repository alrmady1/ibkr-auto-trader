// Queues a control command (start / stop / kill / reset-halt / close) for the bot on the user's PC.
// Mode switching and settings changes are intentionally not available remotely.
import crypto from "node:crypto";
import { handler, requireSession, requireMethod, requireJson, redisEval, KEYS, HttpError } from "./_lib.js";

const ALLOWED = new Set(["start", "stop", "kill", "reset-halt", "close"]);
const SCRIPT = `
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -20, -1)
redis.call('EXPIRE', KEYS[1], 600)
return 1`;

export default handler(async (req) => {
  requireMethod(req, "POST");
  requireJson(req);
  requireSession(req);
  const type = String(req.query.type || "");
  if (!ALLOWED.has(type)) throw new HttpError(400, "أمر غير معروف");
  const symbol = type === "close" ? String(req.query.symbol || "").toUpperCase() : undefined;
  if (type === "close" && !/^[A-Z.]{1,6}$/.test(symbol)) throw new HttpError(400, "رمز سهم غير صالح");

  const cmd = { id: crypto.randomUUID(), type, symbol, at: Date.now() };
  await redisEval(SCRIPT, [KEYS.queue], [JSON.stringify(cmd)]);
  return { ok: true, queued: true };
});
