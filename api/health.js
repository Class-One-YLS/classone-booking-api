const { getSql } = require("../lib/db");
const { setCors, sendJson, handleOptions, safeError } = require("../lib/http");

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;

  if (req.method !== "GET") {
    return sendJson(res, 405, { ok: false, error: "Method not allowed." });
  }

  const result = {
    ok: true,
    service: "classone-booking-api",
    release: "teacher-view-sync-2026-07-09",
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    time: new Date().toISOString()
  };

  if (req.query && req.query.db === "1") {
    try {
      const sql = getSql();
      const rows = await sql`select now() as now`;
      result.database = { ok: true, now: rows[0].now };
    } catch (error) {
      result.ok = false;
      result.database = { ok: false, error: safeError(error) };
    }
  }

  return sendJson(res, result.ok ? 200 : 500, result);
};
