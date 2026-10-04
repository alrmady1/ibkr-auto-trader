// Called by the bot running on the user's PC: stores the latest dashboard snapshot
// and hands back any commands queued from the online dashboard.
import { handler, requireBridge, requireMethod, redisEval, KEYS, HttpError } from "./_lib.js";

const SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
local cmds = redis.call('LRANGE', KEYS[3], 0, -1)
redis.call('DEL', KEYS[3])
local view = redis.call('GET', KEYS[4])
return {cmds, view or ''}`;

export default handler(async (req) => {
  requireMethod(req, "POST");
  requireBridge(req);
  const snapshot = req.body?.snapshot;
  if (typeof snapshot !== "string" || snapshot.length > 3_000_000) throw new HttpError(400, "snapshot غير صالح");

  const [cmds, lastView] = await redisEval(SCRIPT, [KEYS.snap, KEYS.pushedAt, KEYS.queue, KEYS.lastView], [snapshot, Date.now()]);
  return {
    commands: (cmds || []).map((c) => JSON.parse(c)),
    viewerActive: lastView ? Date.now() - Number(lastView) < 120000 : false,
  };
});
