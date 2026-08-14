const { ensureCoreTables } = require("../lib/db");
const { loadComposedState } = require("../lib/composed-state");
const { setCors, sendJson, handleOptions, requireApiKey, safeError } = require("../lib/http");

function stateKey(req) {
  return String((req.query && req.query.key) || "production").trim() || "production";
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;

  try {
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    await ensureCoreTables();
    const key = stateKey(req);
    const row = await loadComposedState(key, { backfill: false });
    if (!row.data) return sendJson(res, 200, { ok: true, key, empty: true, version: 0, updatedAt: null, updatedBy: null });
    return sendJson(res, 200, {
      ok: true,
      key: row.key,
      empty: false,
      version: Number(row.version || 0),
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy || null,
      composed: true
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
