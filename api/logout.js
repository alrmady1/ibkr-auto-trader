import { handler, requireMethod, clearCookie } from "./_lib.js";

export default handler(async (req, res) => {
  requireMethod(req, "POST");
  res.setHeader("Set-Cookie", clearCookie);
  return { ok: true };
});
