const crypto = require("node:crypto");
const { ensureCoreTables, getPool } = require("../../lib/db");
const { dateOnly, loadComposedState, normalizeRecurringAssignment, stateKey, timeOnly } = require("../../lib/composed-state");
const { setCors, sendJson, handleOptions, requireApiKey, readJson, safeError } = require("../../lib/http");

const COLLECTION_TABLES = new Map([
  ["bookings", "booking"],
  ["recurringAssignments", "recurringAssignment"],
  ["replacements", "replacement"],
  ["replacementCredits", "replacementCredit"],
  ["activityLogs", "activityLog"],
  ["teachers", "collection"],
  ["students", "collection"],
  ["teacherLeaves", "collection"],
  ["publicHolidays", "collection"],
  ["teacherStudentNotes", "collection"],
  ["teacherFeedback", "collection"]
]);

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

function cleanStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "not_show" || normalized === "student not show") return "student_not_show";
  if (normalized === "canceled") return "cancelled";
  return normalized || "booked";
}

function recordId(record) {
  return String(record?.id || record?.bookingId || record?.assignmentId || record?.normalizedRecurringAssignmentId || record?.recurringAssignmentId || record?.creditId || record?.replacementId || "").trim();
}

function recordTime(record) {
  return Math.max(
    Date.parse(record?.updatedAt || "") || 0,
    Date.parse(record?.statusChangedAt || "") || 0,
    Date.parse(record?.changedAt || "") || 0,
    Date.parse(record?.deletedAt || "") || 0,
    Date.parse(record?.createdAt || "") || 0
  );
}

function currentRecordWins(incoming, existing, id) {
  const incomingTime = recordTime(incoming);
  const existingTime = recordTime(existing);
  if (incomingTime !== existingTime) return incomingTime > existingTime;
  return `${incoming?.deviceId || ""}|${id}` >= `${existing?.deviceId || ""}|${id}`;
}

async function upsertBooking(client, key, record) {
  const id = recordId(record);
  if (!id) throw new Error("Booking id is required.");
  const current = await client.query(
    "select data, record_version from booking_records_v2 where state_key = $1 and booking_id = $2 for update",
    [key, id]
  );
  if (current.rows.length && !currentRecordWins(record, current.rows[0].data, id)) {
    return current.rows[0].data;
  }
  const nextVersion = Number(current.rows[0]?.record_version || current.rows[0]?.data?.recordVersion || 0) + 1;
  const data = {
    ...(current.rows[0]?.data || {}),
    ...record,
    id,
    bookingId: record.bookingId || id,
    status: cleanStatus(record.status),
    recordVersion: nextVersion
  };
  await client.query(
    `insert into booking_records_v2 (state_key, booking_id, teacher_id, student_id, class_date, class_time, status, record_version, data)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     on conflict (state_key, booking_id) do update
     set teacher_id = excluded.teacher_id,
         student_id = excluded.student_id,
         class_date = excluded.class_date,
         class_time = excluded.class_time,
         status = excluded.status,
         record_version = excluded.record_version,
         data = excluded.data,
         updated_at = now()`,
    [key, id, data.teacherId || "", data.studentId || "", dateOnly(data.date), timeOnly(data.time), data.status || "", nextVersion, JSON.stringify(data)]
  );
  return data;
}

async function upsertReplacementTable(client, key, collectionName, record) {
  const id = recordId(record);
  if (!id) throw new Error(`${collectionName} id is required.`);
  const table = collectionName === "replacementCredits" ? "replacement_credit_records_v2" : "replacement_records_v2";
  const idColumn = collectionName === "replacementCredits" ? "credit_id" : "replacement_id";
  const current = await client.query(
    `select data, record_version from ${table} where state_key = $1 and ${idColumn} = $2 for update`,
    [key, id]
  );
  if (current.rows.length && !currentRecordWins(record, current.rows[0].data, id)) {
    return current.rows[0].data;
  }
  const nextVersion = Number(current.rows[0]?.record_version || current.rows[0]?.data?.recordVersion || 0) + 1;
  const data = { ...(current.rows[0]?.data || {}), ...record, id, recordVersion: nextVersion };
  await client.query(
    `insert into ${table} (state_key, ${idColumn}, source_booking_id, source_occurrence_id, student_id, teacher_id, original_date, original_time, record_version, data)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     on conflict (state_key, ${idColumn}) do update
     set source_booking_id = excluded.source_booking_id,
         source_occurrence_id = excluded.source_occurrence_id,
         student_id = excluded.student_id,
         teacher_id = excluded.teacher_id,
         original_date = excluded.original_date,
         original_time = excluded.original_time,
         record_version = excluded.record_version,
         data = excluded.data,
         updated_at = now()`,
    [
      key,
      id,
      data.sourceBookingId || data.originalBookingId || data.bookingId || "",
      data.sourceOccurrenceId || "",
      data.studentId || "",
      data.teacherId || data.originalTeacherId || "",
      dateOnly(data.originalDate || data.date),
      timeOnly(data.originalTime || data.time),
      nextVersion,
      JSON.stringify(data)
    ]
  );
  return data;
}

async function upsertRecurringAssignment(client, key, record) {
  const assignment = normalizeRecurringAssignment(record, null, record.sourceCollection || "regularSlots");
  const id = String(assignment.assignmentId || "").trim();
  if (!id) throw new Error("Recurring assignment id is required.");
  const current = await client.query(
    "select data, record_version from recurring_assignments_v2 where state_key = $1 and assignment_id = $2 for update",
    [key, id]
  );
  if (current.rows.length && !currentRecordWins(assignment, current.rows[0].data, id)) {
    return current.rows[0].data;
  }
  const nextVersion = Number(current.rows[0]?.record_version || current.rows[0]?.data?.recordVersion || 0) + 1;
  const data = { ...(current.rows[0]?.data || {}), ...assignment, assignmentId: id, normalizedRecurringAssignmentId: id, recordVersion: nextVersion };
  await client.query(
    `insert into recurring_assignments_v2 (
       state_key, assignment_id, teacher_id, student_id, weekday, class_time, status,
       source_collection, source_slot_id, student_slot_id, record_version, data
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     on conflict (state_key, assignment_id) do update
     set teacher_id = excluded.teacher_id,
         student_id = excluded.student_id,
         weekday = excluded.weekday,
         class_time = excluded.class_time,
         status = excluded.status,
         source_collection = excluded.source_collection,
         source_slot_id = excluded.source_slot_id,
         student_slot_id = excluded.student_slot_id,
         record_version = excluded.record_version,
         data = excluded.data,
         updated_at = now()`,
    [
      key,
      id,
      data.teacherId || "",
      data.studentId || "",
      data.day || data.weekday || "",
      timeOnly(data.time),
      data.status || "active",
      data.sourceCollection || "regularSlots",
      data.sourceSlotId || "",
      data.studentSlotId || "",
      nextVersion,
      JSON.stringify(data)
    ]
  );
  return data;
}

async function upsertActivity(client, key, record, actor) {
  const id = recordId(record);
  if (!id) throw new Error("Activity log id is required.");
  await client.query(
    `insert into activity_events_v2 (state_key, event_id, action, entity_type, entity_id, actor, metadata, data)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
     on conflict (state_key, event_id) do nothing`,
    [
      key,
      id,
      record.type || record.action || "Activity",
      record.entityType || record.targetType || "record",
      record.entityId || record.target || "",
      actor || record.user || "app",
      JSON.stringify({ source: "record-transaction" }),
      JSON.stringify(record)
    ]
  );
  return record;
}

async function upsertCollectionRecord(client, key, collectionName, record) {
  const id = recordId(record);
  if (!id) throw new Error(`${collectionName} id is required.`);
  const current = await client.query(
    "select data, record_version from collection_records_v2 where state_key = $1 and collection_name = $2 and record_id = $3 for update",
    [key, collectionName, id]
  );
  if (current.rows.length && !currentRecordWins(record, current.rows[0].data, id)) {
    return current.rows[0].data;
  }
  const nextVersion = Number(current.rows[0]?.record_version || current.rows[0]?.data?.recordVersion || 0) + 1;
  const data = { ...(current.rows[0]?.data || {}), ...record, id, recordVersion: nextVersion };
  await client.query(
    `insert into collection_records_v2 (state_key, collection_name, record_id, record_version, data)
     values ($1,$2,$3,$4,$5::jsonb)
     on conflict (state_key, collection_name, record_id) do update
     set record_version = excluded.record_version,
         data = excluded.data,
         updated_at = now()`,
    [key, collectionName, id, nextVersion, JSON.stringify(data)]
  );
  return data;
}

async function upsertRecord(client, key, collectionName, record, actor) {
  const kind = COLLECTION_TABLES.get(collectionName);
  if (!kind) throw new Error(`Unsupported record collection: ${collectionName}`);
  if (kind === "booking") return upsertBooking(client, key, record);
  if (kind === "recurringAssignment") return upsertRecurringAssignment(client, key, record);
  if (kind === "replacement" || kind === "replacementCredit") return upsertReplacementTable(client, key, collectionName, record);
  if (kind === "activityLog") return upsertActivity(client, key, record, actor);
  return upsertCollectionRecord(client, key, collectionName, record);
}

async function handleTransaction(req, res) {
  await ensureCoreTables();
  const body = await readJson(req);
  const key = stateKey(req, body);
  const requestId = String(body.requestId || "").trim();
  const records = body.records && typeof body.records === "object" ? body.records : null;
  if (!requestId) return sendJson(res, 400, { ok: false, error: "requestId is required." });
  if (!records) return sendJson(res, 400, { ok: false, error: "records is required." });
  if (body.state || body.data || body.payload) {
    return sendJson(res, 400, { ok: false, error: "Full-state payloads are not accepted by record transaction." });
  }

  const composed = await loadComposedState(key, { backfill: false });
  const email = verifiedSessionEmail(req, body);
  if (!userCanWrite(composed.data || {}, email)) {
    return sendJson(res, 403, { ok: false, error: "You do not have permission to save records." });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const previousRequest = await client.query(
      "select response from record_transaction_requests_v2 where state_key = $1 and request_id = $2 limit 1",
      [key, requestId]
    );
    if (previousRequest.rows.length) {
      await client.query("commit");
      return sendJson(res, 200, previousRequest.rows[0].response);
    }

    const saved = {};
    for (const [collectionName, list] of Object.entries(records)) {
      if (!COLLECTION_TABLES.has(collectionName)) throw new Error(`Unsupported record collection: ${collectionName}`);
      saved[collectionName] = [];
      for (const record of (Array.isArray(list) ? list : [])) {
        if (!record || typeof record !== "object") continue;
        saved[collectionName].push(await upsertRecord(client, key, collectionName, record, email || body.updatedBy || "app"));
      }
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
      records: saved
    };
    await client.query(
      `insert into record_transaction_requests_v2 (state_key, request_id, request_hash, response)
       values ($1,$2,$3,$4::jsonb)`,
      [key, requestId, crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex"), JSON.stringify(response)]
    );
    await client.query("commit");
    return sendJson(res, 200, response);
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
    return await handleTransaction(req, res);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
