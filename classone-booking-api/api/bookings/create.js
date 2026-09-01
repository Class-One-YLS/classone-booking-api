const crypto = require("node:crypto");
const { ensureCoreTables, getPool } = require("../../lib/db");
const { dateOnly, loadComposedState, stateKey, timeOnly } = require("../../lib/composed-state");
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

function cleanStatus(value) {
  const normalized = String(value || "booked").trim().toLowerCase();
  if (normalized === "not_show" || normalized === "student not show") return "student_not_show";
  if (normalized === "canceled") return "cancelled";
  return normalized || "booked";
}

function activeBooking(record) {
  const status = cleanStatus(record && record.status);
  return Boolean(record) && !record.archived && !record.deleted && status !== "deleted" && status !== "cancelled";
}

function bookingIdFrom(body, booking) {
  return String(body.bookingId || booking.id || booking.bookingId || "").trim();
}

function rowVersion(row) {
  return Number(row && (row.record_version || row.recordVersion) || 0);
}

function upsertRecordSql(data, fallbackBookingId = "") {
  return {
    id: String(data.id || data.bookingId || fallbackBookingId || "").trim(),
    teacherId: data.teacherId || data.originalTeacherId || "",
    studentId: data.studentId || "",
    sourceBookingId: data.sourceBookingId || data.originalBookingId || data.bookingId || data.id || "",
    sourceOccurrenceId: data.sourceOccurrenceId || "",
    originalDate: dateOnly(data.originalDate || data.date),
    originalTime: timeOnly(data.originalTime || data.time)
  };
}

async function upsertBooking(client, key, booking, expectedRecordVersion = null) {
  const bookingId = String(booking.id || booking.bookingId || "").trim();
  if (!bookingId) throw new Error("Booking id is required.");
  let current = await client.query(
    "select booking_id, record_version, data from booking_records_v2 where state_key = $1 and booking_id = $2 for update",
    [key, bookingId]
  );
  if (!current.rows.length) {
    await client.query(
      `insert into booking_records_v2 (state_key, booking_id, teacher_id, student_id, class_date, class_time, status, record_version, data)
       values ($1,$2,$3,$4,$5,$6,$7,0,$8::jsonb)
       on conflict (state_key, booking_id) do nothing`,
      [
        key,
        bookingId,
        booking.teacherId || "",
        booking.studentId || "",
        dateOnly(booking.date),
        timeOnly(booking.time),
        cleanStatus(booking.status),
        JSON.stringify({ ...booking, id: bookingId, bookingId, recordVersion: 0 })
      ]
    );
    current = await client.query(
      "select booking_id, record_version, data from booking_records_v2 where state_key = $1 and booking_id = $2 for update",
      [key, bookingId]
    );
  }
  const currentVersion = rowVersion(current.rows[0]);
  if (expectedRecordVersion != null && Number(expectedRecordVersion) !== currentVersion) {
    const error = new Error("Booking was changed by another device.");
    error.status = 409;
    error.code = "RECORD_CONFLICT";
    error.currentRecordVersion = currentVersion;
    error.currentBooking = current.rows[0].data;
    throw error;
  }
  const nextVersion = currentVersion + 1;
  const now = new Date().toISOString();
  const saved = {
    ...current.rows[0].data,
    ...booking,
    id: bookingId,
    bookingId,
    status: cleanStatus(booking.status),
    recordVersion: nextVersion,
    createdAt: booking.createdAt || current.rows[0].data?.createdAt || now,
    updatedAt: booking.updatedAt || now
  };
  await client.query(
    `update booking_records_v2
     set teacher_id = $3,
         student_id = $4,
         class_date = $5,
         class_time = $6,
         status = $7,
         record_version = $8,
         data = $9::jsonb,
         updated_at = now()
     where state_key = $1 and booking_id = $2`,
    [
      key,
      bookingId,
      saved.teacherId || "",
      saved.studentId || "",
      dateOnly(saved.date),
      timeOnly(saved.time),
      saved.status || "",
      nextVersion,
      JSON.stringify(saved)
    ]
  );
  return saved;
}

async function handleCreate(req, res) {
  await ensureCoreTables();
  const body = await readJson(req);
  const key = stateKey(req, body);
  const requestId = String(body.requestId || "").trim();
  const booking = body.booking && typeof body.booking === "object" ? body.booking : null;
  const bookingId = booking ? bookingIdFrom(body, booking) : "";
  if (!requestId) return sendJson(res, 400, { ok: false, error: "requestId is required." });
  if (!booking || !bookingId) return sendJson(res, 400, { ok: false, error: "booking is required." });
  if (!booking.teacherId || !booking.date || !booking.time) return sendJson(res, 400, { ok: false, error: "teacherId, date and time are required." });

  const composed = await loadComposedState(key, { backfill: true });
  const email = verifiedSessionEmail(req, body);
  if (!userCanWrite(composed.data || {}, email)) {
    return sendJson(res, 403, { ok: false, error: "You do not have permission to create bookings." });
  }

  const reuseCancelledBookingId = String(body.reuseCancelledBookingId || booking.reusedCancelledBookingId || "").trim();
  const conflict = cleanStatus(booking.status) === "deleted" ? null : (composed.data?.bookings || []).find(item =>
    activeBooking(item) &&
    String(item.id || item.bookingId || "") !== bookingId &&
    String(item.id || item.bookingId || "") !== reuseCancelledBookingId &&
    String(item.teacherId || "") === String(booking.teacherId || "") &&
    dateOnly(item.date) === dateOnly(booking.date) &&
    timeOnly(item.time) === timeOnly(booking.time)
  );
  if (conflict) {
    return sendJson(res, 409, {
      ok: false,
      code: "BOOKING_CONFLICT",
      error: `This time already has a class: ${conflict.studentName || "another student"}.`,
      conflictBookingId: conflict.id || conflict.bookingId || ""
    });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const previousRequest = await client.query(
      "select response from booking_create_requests_v2 where state_key = $1 and request_id = $2 limit 1",
      [key, requestId]
    );
    if (previousRequest.rows.length) {
      await client.query("commit");
      return sendJson(res, 200, previousRequest.rows[0].response);
    }

    const savedBooking = await upsertBooking(client, key, { ...booking, id: bookingId, bookingId }, body.expectedRecordVersion);

    const supersededBooking = body.supersededBooking && typeof body.supersededBooking === "object" ? body.supersededBooking : null;
    let savedSupersededBooking = null;
    if (supersededBooking?.id || supersededBooking?.bookingId) {
      savedSupersededBooking = await upsertBooking(client, key, supersededBooking, body.supersededExpectedRecordVersion);
    }

    const replacementTask = body.replacementTask && typeof body.replacementTask === "object" ? body.replacementTask : null;
    if (replacementTask?.id) {
      const item = upsertRecordSql(replacementTask, bookingId);
      await client.query(
        `insert into replacement_records_v2 (state_key, replacement_id, source_booking_id, source_occurrence_id, student_id, teacher_id, original_date, original_time, data)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         on conflict (state_key, replacement_id) do update
         set source_booking_id = excluded.source_booking_id,
             source_occurrence_id = excluded.source_occurrence_id,
             student_id = excluded.student_id,
             teacher_id = excluded.teacher_id,
             original_date = excluded.original_date,
             original_time = excluded.original_time,
             record_version = replacement_records_v2.record_version + 1,
             data = excluded.data,
             updated_at = now()`,
        [key, item.id, item.sourceBookingId, item.sourceOccurrenceId, item.studentId, item.teacherId, item.originalDate, item.originalTime, JSON.stringify(replacementTask)]
      );
    }

    const replacementCredit = body.replacementCredit && typeof body.replacementCredit === "object" ? body.replacementCredit : null;
    if (replacementCredit?.id) {
      const item = upsertRecordSql(replacementCredit, bookingId);
      await client.query(
        `insert into replacement_credit_records_v2 (state_key, credit_id, source_booking_id, source_occurrence_id, student_id, teacher_id, original_date, original_time, data)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         on conflict (state_key, credit_id) do update
         set source_booking_id = excluded.source_booking_id,
             source_occurrence_id = excluded.source_occurrence_id,
             student_id = excluded.student_id,
             teacher_id = excluded.teacher_id,
             original_date = excluded.original_date,
             original_time = excluded.original_time,
             record_version = replacement_credit_records_v2.record_version + 1,
             data = excluded.data,
             updated_at = now()`,
        [key, item.id, item.sourceBookingId, item.sourceOccurrenceId, item.studentId, item.teacherId, item.originalDate, item.originalTime, JSON.stringify(replacementCredit)]
      );
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
          activityLog.type || activityLog.action || "Booking Created",
          "booking",
          bookingId,
          activityLog.user || body.updatedBy || email || "app",
          JSON.stringify({ bookingId, operation: "create" }),
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
      booking: savedBooking,
      supersededBooking: savedSupersededBooking,
      replacementTask,
      replacementCredit,
      activityLog,
      recordVersion: savedBooking.recordVersion
    };
    await client.query(
      `insert into booking_create_requests_v2 (state_key, request_id, booking_id, request_hash, response)
       values ($1,$2,$3,$4,$5::jsonb)`,
      [key, requestId, bookingId, crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex"), JSON.stringify(response)]
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
        currentBooking: error.currentBooking
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
    return await handleCreate(req, res);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
