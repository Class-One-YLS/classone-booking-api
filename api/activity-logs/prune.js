const { ensureCoreTables, getPool } = require("../../lib/db");
const { setCors, sendJson, handleOptions, requireApiKey, readJson, safeError } = require("../../lib/http");

function stateKey(req, body) {
  return String((body && body.key) || (req.query && req.query.key) || "production").trim() || "production";
}

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function roleByName(state, name) {
  return (state.roles || []).find(role => role && role.name === name) || null;
}

function userCanWrite(state, email) {
  const users = Array.isArray(state && state.users) ? state.users : [];
  if (!users.length) return true;
  const hasValidMaster = users.some(item => item && item.role === "master_admin" && item.status !== "disabled" && normalizedEmail(item.email));
  if (!hasValidMaster && email === "master@classone.local") return true;
  const user = users.find(item => normalizedEmail(item.email) === email && item.status !== "disabled");
  if (!user) return false;
  if (user.role === "master_admin") return true;
  const role = roleByName(state, user.role);
  return Array.isArray(role && role.permissions) && role.permissions.includes("save");
}

const crypto = require("node:crypto");
function verifiedSessionEmail(req, body = {}) {
  const token = String(req.headers["x-user-session"] || body.userSession || "");
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return "";
  const expected = crypto.createHmac("sha256", process.env.API_SECRET || "").update(payload).digest("base64url");
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return "";
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return "";
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (Number(data.exp || 0) < Date.now()) return "";
    return normalizedEmail(data.email);
  } catch (error) {
    return "";
  }
}

// Permanently deletes activity log entries older than a cutoff date, from BOTH storage layers:
// - activity_events_v2 (the newer per-record table most write paths insert into now; it's
//   insert-only from the app's own record-transaction endpoint, so a real SQL DELETE is the only way
//   to remove rows there).
// - app_state.data.activityLogs (the legacy full-state blob), which loadComposedState() otherwise
//   re-merges activity_events_v2 rows on top of, so both have to be pruned together or deleted
//   entries would just reappear on the next read.
// This is real, irreversible deletion (unlike the undo-snapshot cleanup, which only strips a field
// off records that are kept). It exists as an admin-triggered endpoint specifically so the deletion
// runs under the calling admin's own authenticated session, not as something this tool performs on
// its own initiative.
async function handlePrune(req, res) {
  await ensureCoreTables();
  const body = await readJson(req);
  const key = stateKey(req, body);
  const beforeDate = String(body.beforeDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
    return sendJson(res, 400, { ok: false, error: "beforeDate must be an ISO date (YYYY-MM-DD)." });
  }
  const beforeIso = `${beforeDate}T00:00:00.000Z`;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");

    const currentRows = await client.query("select data, version from app_state where key = $1 for update", [key]);
    if (!currentRows.rows.length) {
      await client.query("rollback");
      return sendJson(res, 404, { ok: false, error: "State not found." });
    }
    const currentState = currentRows.rows[0].data || {};
    const currentVersion = Number(currentRows.rows[0].version || 0);
    const email = verifiedSessionEmail(req, body);
    if (!userCanWrite(currentState, email)) {
      await client.query("rollback");
      return sendJson(res, 403, { ok: false, error: "You do not have permission to delete activity log history." });
    }

    const legacyLogs = Array.isArray(currentState.activityLogs) ? currentState.activityLogs : [];
    const keptLegacyLogs = legacyLogs.filter(log => String(log?.createdAt || "9999") >= beforeIso);
    const legacyRemovedCount = legacyLogs.length - keptLegacyLogs.length;
    const mergedState = { ...currentState, activityLogs: keptLegacyLogs };

    const normalizedDeleteResult = await client.query(
      `delete from activity_events_v2
       where state_key = $1
         and coalesce(data ->> 'createdAt', '') <> ''
         and (data ->> 'createdAt') < $2
       returning event_id`,
      [key, beforeIso]
    );

    const savedRows = await client.query(
      `update app_state
       set data = $2::jsonb, version = version + 1, updated_at = now()
       where key = $1 and version = $3
       returning version, updated_at`,
      [key, JSON.stringify(mergedState), currentVersion]
    );
    if (!savedRows.rows.length) {
      await client.query("rollback");
      return sendJson(res, 409, { ok: false, error: "Version conflict. Please reload and try again.", currentVersion });
    }

    const updatedBy = String(body.updatedBy || email || "app").slice(0, 120);
    await client.query(
      `insert into audit_logs (action, entity_type, entity_id, summary, after_data, created_by)
       values ('activity_log_pruned', 'app_state', $1, $2, $3::jsonb, $4)`,
      [
        key,
        `Deleted activity log entries older than ${beforeDate}`,
        JSON.stringify({ beforeDate, legacyRemovedCount, normalizedRemovedCount: normalizedDeleteResult.rowCount || 0 }),
        updatedBy
      ]
    );

    await client.query("commit");
    return sendJson(res, 200, {
      ok: true,
      key,
      beforeDate,
      legacyRemovedCount,
      normalizedRemovedCount: normalizedDeleteResult.rowCount || 0,
      remainingCount: keptLegacyLogs.length,
      version: Number(savedRows.rows[0].version || 0),
      updatedAt: savedRows.rows[0].updated_at
    });
  } catch (error) {
    try { await client.query("rollback"); } catch (rollbackError) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;
  try {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    return await handlePrune(req, res);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
