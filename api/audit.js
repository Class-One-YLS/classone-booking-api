const { getSql, ensureCoreTables } = require("../lib/db");
const { setCors, sendJson, handleOptions, requireApiKey, readJson, safeError } = require("../lib/http");

async function listAudit(req, res) {
  await ensureCoreTables();
  const sql = getSql();
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
  const rows = await sql`
    select id, action, entity_type, entity_id, summary, before_data, after_data, created_by, created_at
    from audit_logs
    order by created_at desc, id desc
    limit ${limit}
  `;
  return sendJson(res, 200, { ok: true, rows });
}

async function createAudit(req, res) {
  await ensureCoreTables();
  const body = await readJson(req);
  const sql = getSql();
  const action = String(body.action || "").trim();
  if (!action) return sendJson(res, 400, { ok: false, error: "action is required." });

  const rows = await sql`
    insert into audit_logs (action, entity_type, entity_id, summary, before_data, after_data, created_by)
    values (
      ${action},
      ${body.entityType || null},
      ${body.entityId || null},
      ${body.summary || null},
      ${body.beforeData ? JSON.stringify(body.beforeData) : null}::jsonb,
      ${body.afterData ? JSON.stringify(body.afterData) : null}::jsonb,
      ${body.createdBy || "app"}
    )
    returning id, created_at
  `;
  return sendJson(res, 200, { ok: true, id: rows[0].id, createdAt: rows[0].created_at });
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;

  try {
    if (req.method === "GET") return await listAudit(req, res);
    if (req.method === "POST") return await createAudit(req, res);
    return sendJson(res, 405, { ok: false, error: "Method not allowed." });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
