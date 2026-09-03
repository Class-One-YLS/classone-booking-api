const crypto = require("node:crypto");
const { ensureCoreTables, getPool } = require("../../lib/db");
const { normalizeRecurringAssignment, stateKey, timeOnly, loadUsersAndRolesForPermissionCheck } = require("../../lib/composed-state");
const { setCors, sendJson, handleOptions, requireApiKey, readJson, safeError } = require("../../lib/http");

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

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

function rowVersion(row) {
  return Number(row && (row.record_version || row.recordVersion) || 0);
}

async function upsertAssignment(client, key, rawAssignment, expectedRecordVersion = null) {
  const assignment = normalizeRecurringAssignment(rawAssignment, null, rawAssignment.sourceCollection || "regularSlots");
  const assignmentId = assignment.assignmentId;
  if (!assignmentId) throw new Error("assignmentId is required.");
  if (!assignment.teacherId || !assignment.day || !assignment.time) throw new Error("teacherId, day and time are required.");
  let current = await client.query(
    "select assignment_id, record_version, data from recurring_assignments_v2 where state_key = $1 and assignment_id = $2 for update",
    [key, assignmentId]
  );
  if (!current.rows.length) {
    await client.query(
      `insert into recurring_assignments_v2 (
        state_key, assignment_id, teacher_id, student_id, weekday, class_time, status,
        source_collection, source_slot_id, student_slot_id, record_version, data
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11::jsonb)
       on conflict (state_key, assignment_id) do nothing`,
      [
        key,
        assignmentId,
        assignment.teacherId || "",
        assignment.studentId || "",
        assignment.day || assignment.weekday || "",
        timeOnly(assignment.time),
        assignment.status || "active",
        assignment.sourceCollection || "regularSlots",
        assignment.sourceSlotId || assignment.id || "",
        assignment.studentSlotId || "",
        JSON.stringify({ ...assignment, recordVersion: 0 })
      ]
    );
    current = await client.query(
      "select assignment_id, record_version, data from recurring_assignments_v2 where state_key = $1 and assignment_id = $2 for update",
      [key, assignmentId]
    );
  }
  const currentVersion = rowVersion(current.rows[0]);
  if (expectedRecordVersion != null && Number(expectedRecordVersion) !== currentVersion) {
    const error = new Error("Recurring assignment was changed by another device.");
    error.status = 409;
    error.code = "RECORD_CONFLICT";
    error.currentRecordVersion = currentVersion;
    error.currentAssignment = current.rows[0].data;
    throw error;
  }
  const nextVersion = currentVersion + 1;
  const now = new Date().toISOString();
  const saved = {
    ...current.rows[0].data,
    ...assignment,
    assignmentId,
    normalizedRecurringAssignmentId: assignmentId,
    recordVersion: nextVersion,
    createdAt: assignment.createdAt || current.rows[0].data?.createdAt || now,
    updatedAt: assignment.updatedAt || now
  };
  await client.query(
    `update recurring_assignments_v2
     set teacher_id = $3,
         student_id = $4,
         weekday = $5,
         class_time = $6,
         status = $7,
         source_collection = $8,
         source_slot_id = $9,
         student_slot_id = $10,
         record_version = $11,
         data = $12::jsonb,
         updated_at = now()
     where state_key = $1 and assignment_id = $2`,
    [
      key,
      assignmentId,
      saved.teacherId || "",
      saved.studentId || "",
      saved.day || saved.weekday || "",
      timeOnly(saved.time),
      saved.status || "active",
      saved.sourceCollection || "regularSlots",
      saved.sourceSlotId || saved.id || "",
      saved.studentSlotId || "",
      nextVersion,
      JSON.stringify(saved)
    ]
  );
  return saved;
}

async function handleUpsert(req, res) {
  await ensureCoreTables();
  const body = await readJson(req);
  const key = stateKey(req, body);
  const requestId = String(body.requestId || "").trim();
  const assignments = Array.isArray(body.assignments)
    ? body.assignments
    : (body.assignment && typeof body.assignment === "object" ? [body.assignment] : []);
  if (!requestId) return sendJson(res, 400, { ok: false, error: "requestId is required." });
  if (!assignments.length) return sendJson(res, 400, { ok: false, error: "assignment is required." });

  const composed = await loadComposedState(key, { backfill: true });
  const email = verifiedSessionEmail(req, body);
  if (!userCanWrite(composed.data || {}, email)) {
    return sendJson(res, 403, { ok: false, error: "You do not have permission to save recurring assignments." });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const previousRequest = await client.query(
      "select response from recurring_assignment_requests_v2 where state_key = $1 and request_id = $2 limit 1",
      [key, requestId]
    );
    if (previousRequest.rows.length) {
      await client.query("commit");
      return sendJson(res, 200, previousRequest.rows[0].response);
    }

    const expectedVersions = body.expectedRecordVersions && typeof body.expectedRecordVersions === "object" ? body.expectedRecordVersions : {};
    const savedAssignments = [];
    for (const assignment of assignments) {
      const normalized = normalizeRecurringAssignment(assignment, null, assignment.sourceCollection || "regularSlots");
      const expected = assignment.expectedRecordVersion == null
        ? expectedVersions[normalized.assignmentId]
        : assignment.expectedRecordVersion;
      savedAssignments.push(await upsertAssignment(client, key, normalized, expected));
    }

    const activityLog = body.activityLog && typeof body.activityLog === "object" ? body.activityLog : null;
    if (activityLog?.id) {
      await client.query(
        `insert into activity_events_v2 (state_key, event_id, action, entity_type, entity_id, actor, metadata, data)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
         on conflict (state_key, event_id) do nothing`,
        [
          key,
          activityLog.id,
          activityLog.type || activityLog.action || "Recurring Assignment Updated",
          "recurring_assignment",
          savedAssignments[0]?.assignmentId || "",
          activityLog.user || body.updatedBy || email || "app",
          JSON.stringify({ assignmentIds: savedAssignments.map(item => item.assignmentId) }),
          JSON.stringify(activityLog)
        ]
      );
    }

    const versionRows = await client.query(
      `insert into system_versions (state_key, version, updated_at)
       values (
         $1,
         greatest(
           0,
           coalesce((select version from system_versions where state_key = $1), 0),
           coalesce((select version from app_state where key = $1), 0)
         ) + 1,
         now()
       )
       on conflict (state_key) do update
       set version = greatest(
             system_versions.version,
             coalesce((select version from app_state where key = $1), 0)
           ) + 1,
           updated_at = now()
       returning version, updated_at`,
      [key]
    );
    const response = {
      ok: true,
      success: true,
      key,
      version: Number(versionRows.rows[0].version || 0),
      updatedAt: versionRows.rows[0].updated_at,
      assignment: savedAssignments[0] || null,
      assignments: savedAssignments,
      activityLog,
      recordVersion: savedAssignments[0]?.recordVersion || 0
    };
    await client.query(
      `insert into recurring_assignment_requests_v2 (state_key, request_id, assignment_id, request_hash, response)
       values ($1,$2,$3,$4,$5::jsonb)`,
      [
        key,
        requestId,
        savedAssignments[0]?.assignmentId || "",
        crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex"),
        JSON.stringify(response)
      ]
    );
    await client.query("commit");
    return sendJson(res, 200, response);
  } catch (error) {
    try { await client.query("rollback"); } catch (rollbackError) {}
    if (error.status === 409) {
      return sendJson(res, 409, {
        ok: false,
        code: error.code || "RECORD_CONFLICT",
        error: error.message,
        currentRecordVersion: error.currentRecordVersion,
        currentAssignment: error.currentAssignment
      });
    }
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
    return await handleUpsert(req, res);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
