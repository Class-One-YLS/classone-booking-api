const { getSql, ensureCoreTables } = require("../lib/db");
const { setCors, sendJson, handleOptions, requireApiKey, readJson, safeError } = require("../lib/http");

function stateKey(req, body) {
  return String((body && body.key) || (req.query && req.query.key) || "production").trim() || "production";
}

async function loadState(req, res) {
  await ensureCoreTables();
  const sql = getSql();
  const key = stateKey(req);
  const rows = await sql`
    select key, data, version, updated_at, updated_by
    from app_state
    where key = ${key}
    limit 1
  `;
  if (!rows.length) {
    return sendJson(res, 200, { ok: true, key, data: null, version: 0, updatedAt: null, updatedBy: null });
  }
  const row = rows[0];
  return sendJson(res, 200, {
    ok: true,
    key: row.key,
    data: row.data,
    version: Number(row.version || 0),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by || null
  });
}

async function saveState(req, res) {
  await ensureCoreTables();
  const body = await readJson(req);
  const sql = getSql();
  const key = stateKey(req, body);
  const data = body.data;
  const expectedVersion = body.expectedVersion == null ? null : Number(body.expectedVersion);
  const updatedBy = String(body.updatedBy || "app").slice(0, 120);

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return sendJson(res, 400, { ok: false, error: "Body must include data as an object." });
  }

  if (expectedVersion != null) {
    const current = await sql`select version from app_state where key = ${key} limit 1`;
    const currentVersion = current.length ? Number(current[0].version || 0) : 0;
    if (currentVersion !== expectedVersion) {
      return sendJson(res, 409, {
        ok: false,
        error: "Version conflict. Please reload latest data first.",
        currentVersion
      });
    }
  }

  const rows = await sql`
    insert into app_state (key, data, version, updated_by)
    values (${key}, ${JSON.stringify(data)}::jsonb, 1, ${updatedBy})
    on conflict (key) do update
    set data = excluded.data,
        version = app_state.version + 1,
        updated_at = now(),
        updated_by = excluded.updated_by
    returning key, version, updated_at, updated_by
  `;

  await sql`
    insert into audit_logs (action, entity_type, entity_id, summary, after_data, created_by)
    values (
      'app_state_saved',
      'app_state',
      ${key},
      ${`Saved app state ${key}`},
      ${JSON.stringify({ version: Number(rows[0].version || 0) })}::jsonb,
      ${updatedBy}
    )
  `;

  return sendJson(res, 200, {
    ok: true,
    key: rows[0].key,
    version: Number(rows[0].version || 0),
    updatedAt: rows[0].updated_at,
    updatedBy: rows[0].updated_by || null
  });
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;

  try {
    if (req.method === "GET") return await loadState(req, res);
    if (req.method === "PUT" || req.method === "POST") return await saveState(req, res);
    return sendJson(res, 405, { ok: false, error: "Method not allowed." });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
