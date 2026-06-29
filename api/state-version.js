const { getSql, ensureCoreTables } = require("../lib/db");
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
    const sql = getSql();
    const key = stateKey(req);
    const rows = await sql`
      select key, version, updated_at, updated_by
      from app_state
      where key = ${key}
      limit 1
    `;
    if (!rows.length) return sendJson(res, 200, { ok: true, key, empty: true, version: 0, updatedAt: null, updatedBy: null });
    const row = rows[0];
    return sendJson(res, 200, {
      ok: true,
      key: row.key,
      empty: false,
      version: Number(row.version || 0),
      updatedAt: row.updated_at,
      updatedBy: row.updated_by || null
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
