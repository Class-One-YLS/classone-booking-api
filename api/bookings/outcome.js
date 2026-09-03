const crypto = require("node:crypto");
const { ensureCoreTables, getPool } = require("../../lib/db");
const { dateOnly, stateKey, timeOnly, loadUsersAndRolesForPermissionCheck } = require("../../lib/composed-state");
const { setCors, sendJson, handleOptions, requireApiKey, readJson, safeError } = require("../../lib/http");

const ALLOWED_OUTCOMES = new Set(["cancelled", "completed", "student_not_show", "teacher_leave", "public_holiday", "booked", "restore"]);
const OUTCOME_MAX_ATTEMPTS = 2;

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  return Date.now();
}

function createOutcomeTrace() {
  return {
    startedAt: nowMs(),
    lastAt: nowMs(),
    requestId: "",
    bookingId: "",
    outcome: "",
    attempt: 0,
    stages: []
  };
}

function markOutcomeTrace(trace, stage, details = {}) {
  if (!trace) return;
  const at = nowMs();
  trace.stages.push({
    stage,
    ms: Math.round((at - trace.lastAt) * 10) / 10,
    totalMs: Math.round((at - trace.startedAt) * 10) / 10,
    ...details
  });
  trace.lastAt = at;
}

function logOutcomeTrace(trace, level = "info", extra = {}) {
  if (!trace) return;
  const payload = {
    endpoint: "/api/bookings/outcome",
    requestId: trace.requestId,
    bookingId: trace.bookingId,
    outcome: trace.outcome,
    attempt: trace.attempt,
    totalMs: Math.round((nowMs() - trace.startedAt) * 10) / 10,
    stages: trace.stages,
    ...extra
  };
  const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  logger("BOOKING OUTCOME DELTA SYNC", payload);
}

function isRetryableDbTermination(error) {
  const message = String(error && error.message || "").toLowerCase();
  const code = String(error && error.code || "").toLowerCase();
  return (
    message.includes("terminated") ||
    message.includes("connection terminated") ||
    message.includes("connection closed") ||
    message.includes("client has encountered a connection error") ||
    message.includes("timeout exceeded") ||
    code === "57p01" ||
    code === "57p02" ||
    code === "57p03" ||
    code === "08006" ||
    code === "08003" ||
    code === "econnreset" ||
    code === "etimedout"
  );
}

function outcomeSafeError(error) {
  if (isRetryableDbTermination(error)) {
    return "Booking outcome sync could not reach the database. Please retry.";
  }
  return safeError(error);
}

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function roleByName(state, name) {
  return (state.roles || []).find(role => role && role.name === name) || null;
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

function cleanOutcome(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "not_show" || normalized === "student not show") return "student_not_show";
  if (normalized === "canceled") return "cancelled";
  return normalized;
}

function canonicalBookingId(booking, body) {
  return String(body.bookingId || booking.id || booking.bookingId || "").trim();
}

function occurrenceKeyFromParts(sourceSlotId, date) {
  const source = String(sourceSlotId || "").trim();
  const dateStr = dateOnly(date);
  return source && dateStr ? `${source}|${dateStr}` : "";
}

function recurringSourceFromOccurrenceKey(record) {
  const values = [
    record && record.sourceOccurrenceKey,
    record && record.occurrenceKey,
    String(record && record.sourceOccurrenceId || "").startsWith("occurrence:") ? String(record.sourceOccurrenceId).slice("occurrence:".length) : "",
    String(record && record.occurrenceId || "").startsWith("occurrence:") ? String(record.occurrenceId).slice("occurrence:".length) : ""
  ];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || !text.includes("|")) continue;
    const [source, date] = text.split("|");
    if (source && dateOnly(date)) return source;
  }
  return "";
}

function recurringSourceSlotId(record) {
  return record && (
    record.normalizedRecurringAssignmentId ||
    record.assignmentId ||
    record.recurringAssignmentId ||
    record.recurringSourceSlotId ||
    record.sourceSlotId ||
    record.recurringScheduleId ||
    record.movedFromRecurringClassId ||
    recurringSourceFromOccurrenceKey(record)
  ) || "";
}

function normalizeOutcomeBookingRecord(record, outcome, now) {
  const booking = { ...(record || {}) };
  const finalStatus = outcome === "restore" ? "booked" : (cleanOutcome(outcome) || cleanOutcome(booking.status || booking.outcome));
  const sourceSlotId = recurringSourceSlotId(booking);
  const date = dateOnly(booking.date || booking.occurrenceDate);
  booking.status = finalStatus;
  booking.outcome = finalStatus;
  booking.classOutcome = finalStatus;
  booking.updatedAt = booking.updatedAt || now;
  booking.statusChangedAt = booking.statusChangedAt || now;
  booking.slotRevisionAt = booking.slotRevisionAt || booking.statusChangedAt || booking.updatedAt || now;
  if (sourceSlotId && date) {
    booking.recurringSourceSlotId = sourceSlotId;
    booking.occurrenceDate = date;
    booking.occurrenceKey = booking.occurrenceKey || occurrenceKeyFromParts(sourceSlotId, date);
    booking.sourceOccurrenceKey = booking.sourceOccurrenceKey || booking.occurrenceKey;
    booking.occurrenceId = booking.occurrenceId || `occurrence:${booking.occurrenceKey}`;
    booking.suppressRecurringOccurrence = true;
    booking.resolutionActive = true;
    booking.resolutionStatus = finalStatus;
  }
  if (finalStatus === "cancelled") booking.cancelledAt = booking.cancelledAt || now;
  if (finalStatus === "teacher_leave") booking.teacherLeaveAt = booking.teacherLeaveAt || now;
  if (finalStatus === "public_holiday") booking.publicHolidayAt = booking.publicHolidayAt || now;
  if (finalStatus === "student_not_show") booking.studentNotShowAt = booking.studentNotShowAt || now;
  if (finalStatus === "completed") {
    booking.completedAt = booking.completedAt || now;
    booking.finalizedAt = booking.finalizedAt || now;
  }
  booking.archived = false;
  booking.deleted = false;
  booking.active = booking.active !== false;
  return booking;
}

function rowDataVersion(row) {
  return Number(row && (row.record_version || row.recordVersion) || 0);
}

function upsertRecordSql(table, idColumn, id, data, extra = {}) {
  return {
    table,
    idColumn,
    id,
    data,
    teacherId: extra.teacherId || data.teacherId || data.originalTeacherId || "",
    studentId: extra.studentId || data.studentId || "",
    sourceBookingId: extra.sourceBookingId || data.sourceBookingId || data.originalBookingId || data.bookingId || "",
    sourceOccurrenceId: extra.sourceOccurrenceId || data.sourceOccurrenceId || "",
    originalDate: dateOnly(extra.originalDate || data.originalDate || data.date),
    originalTime: timeOnly(extra.originalTime || data.originalTime || data.time)
  };
}

async function handleOutcome(req, res) {
  const trace = createOutcomeTrace();
  markOutcomeTrace(trace, "request start");
  await ensureCoreTables();
  markOutcomeTrace(trace, "schema ready");
  const body = await readJson(req);
  markOutcomeTrace(trace, "request body parsed", { bytes: Buffer.byteLength(JSON.stringify(body || {}), "utf8") });
  const key = stateKey(req, body);
  const requestId = String(body.requestId || "").trim();
  const booking = body.booking && typeof body.booking === "object" ? body.booking : null;
  const outcome = cleanOutcome(body.outcome || booking?.status);
  const bookingId = canonicalBookingId(booking || {}, body);
  trace.requestId = requestId;
  trace.bookingId = bookingId;
  trace.outcome = outcome;
  if (!requestId) return sendJson(res, 400, { ok: false, error: "requestId is required." });
  if (!bookingId || !booking) return sendJson(res, 400, { ok: false, error: "bookingId and booking are required." });
  if (!ALLOWED_OUTCOMES.has(outcome)) return sendJson(res, 400, { ok: false, error: "Unsupported booking outcome for delta sync." });

  // Only ever needed .data.users/.data.roles for the permission check below -- but
  // loadComposedState(key, {backfill:true}) doesn't just read those; {backfill:true} walks every
  // booking AND every teacher's regularSlots/overrideSlots and does one SELECT + one INSERT/UPDATE
  // per record against recurring_assignments_v2/booking_records_v2 (thousands of sequential DB round
  // trips for this project's data). Running that on every single booking-outcome save (cancel,
  // complete, etc.) is what caused "took too long to respond" / sync-failed timeouts reported
  // 2026-09-02. loadUsersAndRolesForPermissionCheck() reads just users/roles (still cheap) but ALSO
  // merges in users/roles created or edited through the newer collection_records_v2 path -- a plain
  // legacy-blob-only read (the first version of this fix) missed those, so a user who only exists
  // there would get "You do not have permission" even with a fully valid session (see
  // loadUsersAndRolesForPermissionCheck's comment: the same gap broke login for Kelvin, 2026-09-03).
  const permissionState = await loadUsersAndRolesForPermissionCheck(key);
  markOutcomeTrace(trace, "permission state loaded");
  const email = verifiedSessionEmail(req, body);
  if (!userCanWrite(permissionState, email)) {
    return sendJson(res, 403, { ok: false, error: "You do not have permission to save booking outcomes." });
  }
  markOutcomeTrace(trace, "permission checked");

  const pool = getPool();
  let lastError = null;
  for (let attempt = 1; attempt <= OUTCOME_MAX_ATTEMPTS; attempt += 1) {
    trace.attempt = attempt;
    let client = null;
    let releaseError = null;
    let transactionOpen = false;
    let committed = false;
    try {
    client = await pool.connect();
    markOutcomeTrace(trace, "client acquired", { attempt });
    await client.query("begin");
    transactionOpen = true;
    markOutcomeTrace(trace, "begin", { attempt });

    const previousRequest = await client.query(
      "select response from booking_outcome_requests_v2 where state_key = $1 and request_id = $2 limit 1",
      [key, requestId]
    );
    markOutcomeTrace(trace, "idempotency lookup", { found: Boolean(previousRequest.rows.length) });
    if (previousRequest.rows.length) {
      await client.query("commit");
      committed = true;
      transactionOpen = false;
      markOutcomeTrace(trace, "commit", { idempotent: true });
      logOutcomeTrace(trace);
      return sendJson(res, 200, previousRequest.rows[0].response);
    }

    let current = await client.query(
      "select booking_id, record_version, data from booking_records_v2 where state_key = $1 and booking_id = $2 for update",
      [key, bookingId]
    );
    markOutcomeTrace(trace, "booking row locked", { found: Boolean(current.rows.length) });
    if (!current.rows.length) {
      await client.query(
        `insert into booking_records_v2 (state_key, booking_id, teacher_id, student_id, class_date, class_time, status, record_version, data)
         values ($1, $2, $3, $4, $5, $6, $7, 0, $8::jsonb)
         on conflict (state_key, booking_id) do nothing`,
        [
          key,
          bookingId,
          booking.teacherId || "",
          booking.studentId || "",
          dateOnly(booking.date),
          timeOnly(booking.time),
          booking.status || outcome,
          JSON.stringify({ ...booking, id: bookingId, bookingId, recordVersion: 0 })
        ]
      );
      markOutcomeTrace(trace, "missing booking inserted");
      current = await client.query(
        "select booking_id, record_version, data from booking_records_v2 where state_key = $1 and booking_id = $2 for update",
        [key, bookingId]
      );
      markOutcomeTrace(trace, "inserted booking locked", { found: Boolean(current.rows.length) });
    }

    const currentVersion = rowDataVersion(current.rows[0]);
    const expected = body.expectedRecordVersion == null ? currentVersion : Number(body.expectedRecordVersion);
    if (Number.isFinite(expected) && expected !== currentVersion) {
      await client.query("rollback");
      transactionOpen = false;
      markOutcomeTrace(trace, "record conflict rollback", { currentRecordVersion: currentVersion });
      return sendJson(res, 409, {
        ok: false,
        code: "RECORD_CONFLICT",
        error: "Booking was changed by another device. Reload latest timetable and try again.",
        bookingId,
        currentRecordVersion: currentVersion,
        currentBooking: current.rows[0].data
      });
    }

    const nextVersion = currentVersion + 1;
    const now = new Date().toISOString();
    const savedBooking = normalizeOutcomeBookingRecord({
      ...current.rows[0].data,
      ...booking,
      id: bookingId,
      bookingId,
      recordVersion: nextVersion,
      status: outcome === "restore" ? "booked" : booking.status || outcome,
      outcome: outcome === "restore" ? "booked" : booking.outcome || outcome,
      classOutcome: outcome === "restore" ? "booked" : booking.classOutcome || outcome,
      updatedAt: booking.updatedAt || now
    }, outcome, now);

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
        savedBooking.teacherId || "",
        savedBooking.studentId || "",
        dateOnly(savedBooking.date),
        timeOnly(savedBooking.time),
        savedBooking.status || "",
        nextVersion,
        JSON.stringify(savedBooking)
      ]
    );
    markOutcomeTrace(trace, "booking update", { recordVersion: nextVersion });

    const replacementTask = body.replacementTask && typeof body.replacementTask === "object" ? body.replacementTask : null;
    const replacementCredit = body.replacementCredit && typeof body.replacementCredit === "object" ? body.replacementCredit : null;
    if (replacementTask?.id) {
      const item = upsertRecordSql("replacement_records_v2", "replacement_id", replacementTask.id, replacementTask);
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
      markOutcomeTrace(trace, "replacement side effects", { type: "task" });
    }
    if (replacementCredit?.id) {
      const item = upsertRecordSql("replacement_credit_records_v2", "credit_id", replacementCredit.id, replacementCredit);
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
      markOutcomeTrace(trace, "replacement side effects", { type: "credit" });
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
          activityLog.type || activityLog.action || "Class Outcome Updated",
          "booking",
          bookingId,
          activityLog.user || body.updatedBy || email || "app",
          JSON.stringify({ bookingId, outcome }),
          JSON.stringify(activityLog)
        ]
      );
      markOutcomeTrace(trace, "activity event");
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
    markOutcomeTrace(trace, "system version updated", { version: Number(versionRows.rows[0].version || 0) });
    const response = {
      ok: true,
      success: true,
      key,
      version: Number(versionRows.rows[0].version || 0),
      updatedAt: versionRows.rows[0].updated_at,
      booking: savedBooking,
      replacementTask,
      replacementCredit,
      activityLog,
      recordVersion: nextVersion
    };
    await client.query(
      `insert into booking_outcome_requests_v2 (state_key, request_id, booking_id, request_hash, response)
       values ($1,$2,$3,$4,$5::jsonb)`,
      [key, requestId, bookingId, crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex"), JSON.stringify(response)]
    );
    markOutcomeTrace(trace, "idempotency response saved");
    await client.query("commit");
    committed = true;
    transactionOpen = false;
    markOutcomeTrace(trace, "commit");
    logOutcomeTrace(trace);
    return sendJson(res, 200, response);
  } catch (error) {
    lastError = error;
    releaseError = error;
    if (client && transactionOpen && !committed) {
      try {
        await client.query("rollback");
        markOutcomeTrace(trace, "rollback", { attempt });
      } catch (rollbackError) {
        markOutcomeTrace(trace, "rollback failed", { attempt, error: safeError(rollbackError) });
      }
    }
    if (isRetryableDbTermination(error) && attempt < OUTCOME_MAX_ATTEMPTS) {
      markOutcomeTrace(trace, "retrying after db termination", { attempt, error: safeError(error) });
    } else {
      logOutcomeTrace(trace, "error", { error: safeError(error), retryable: isRetryableDbTermination(error) });
      throw error;
    }
  } finally {
    if (client) client.release(releaseError || undefined);
    markOutcomeTrace(trace, "client released", { attempt, discarded: Boolean(releaseError) });
  }
  }
  throw lastError || new Error("Booking outcome sync failed.");
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;
  try {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    return await handleOutcome(req, res);
  } catch (error) {
    const retryable = isRetryableDbTermination(error);
    return sendJson(res, retryable ? 503 : 500, {
      ok: false,
      retryable,
      error: outcomeSafeError(error)
    });
  }
};
