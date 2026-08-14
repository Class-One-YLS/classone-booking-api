const { ensureCoreTables } = require("../../lib/db");
const { backfillBookingsFromAppState, stateKey } = require("../../lib/composed-state");
const { setCors, sendJson, handleOptions, requireApiKey, safeError } = require("../../lib/http");

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;
  try {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    await ensureCoreTables();
    const key = stateKey(req);
    const result = await backfillBookingsFromAppState(key);
    return sendJson(res, 200, { ok: true, key, ...result });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
