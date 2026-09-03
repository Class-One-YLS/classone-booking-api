const crypto = require("node:crypto");
const { getSql, ensureCoreTables } = require("../lib/db");
const { loadUsersAndRolesForPermissionCheck } = require("../lib/composed-state");
const { setCors, sendJson, handleOptions, requireApiKey, readJson, safeError } = require("../lib/http");

const BUSINESS_COLLECTIONS = [
  "teachers",
  "students",
  "bookings",
  "recurringAssignments",
  "leads",
  "tutorLeads",
  "crmHistoricalMonthlyStats",
  "replacements",
  "replacementCredits",
  "teacherLeaves",
  "publicHolidays",
  "policyRules",
  "revenueEntries",
  "teacherStudentNotes",
  "teacherFeedback",
  "activityLogs",
  "users",
  "roles"
];

function stateKey(req, body) {
  return String((body && body.key) || (req.query && req.query.key) || "production").trim() || "production";
}

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function roleByName(state, name) {
  return (state.roles || []).find(role => role && role.name === name) || null;
}

function userByEmail(state, email) {
  const users = Array.isArray(state && state.users) ? state.users : [];
  return users.find(item => normalizedEmail(item.email) === email && item.status !== "disabled") || null;
}

function userCanWrite(state, email) {
  const users = Array.isArray(state && state.users) ? state.users : [];
  if (!users.length) return true;
  const hasValidMaster = users.some(item => item && item.role === "master_admin" && item.status !== "disabled" && normalizedEmail(item.email));
  if (!hasValidMaster && email === "master@classone.local") return true;
  const user = userByEmail(state, email);
  if (!user) return false;
  if (user.role === "master_admin") return true;
  const role = roleByName(state, user.role);
  return Array.isArray(role && role.permissions) && role.permissions.includes("save");
}

function userCanManageUsers(state, email) {
  const users = Array.isArray(state && state.users) ? state.users : [];
  if (!users.length && email === "master@classone.local") return true;
  const user = userByEmail(state, email);
  if (!user) return false;
  if (user.role === "master_admin") return true;
  const role = roleByName(state, user.role);
  return Array.isArray(role && role.permissions) && role.permissions.includes("user_management");
}

function usersOrRolesPatched(patch) {
  return Boolean((patch?.changes?.users || []).length || (patch?.changes?.roles || []).length);
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

function recordIdForPatch(record, collectionName) {
  if (record && record.id) return String(record.id);
  return `${collectionName}_${crypto.createHash("sha1").update(JSON.stringify(record || {})).digest("hex")}`;
}

function activityTime(value) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function recordTime(record) {
  if (!record) return 0;
  return Math.max(
    activityTime(record.updatedAt),
    activityTime(record.statusChangedAt),
    activityTime(record.changedAt),
    activityTime(record.changedSlot && record.changedSlot.changedAt),
    activityTime(record.rebookedAt),
    activityTime(record.cancelledAt),
    activityTime(record.completedAt),
    activityTime(record.studentNotShowAt),
    activityTime(record.deletedAt),
    activityTime(record.createdAt)
  );
}

function localRecordWins(candidate, existing, id) {
  const candidateTime = recordTime(candidate);
  const existingTime = recordTime(existing);
  if (candidateTime !== existingTime) return candidateTime > existingTime;
  const candidateTie = `${candidate?.deviceId || ""}|${id}`;
  const existingTie = `${existing?.deviceId || ""}|${id}`;
  return candidateTie >= existingTie;
}

function mergeList(remoteList, patchList, collectionName) {
  const result = Array.isArray(remoteList) ? remoteList.map(item => ({ ...item })) : [];
  const indexById = new Map(result.map((record, index) => [recordIdForPatch(record, collectionName), index]));
  (Array.isArray(patchList) ? patchList : []).forEach(record => {
    if (!record || typeof record !== "object") return;
    const id = recordIdForPatch(record, collectionName);
    if (!indexById.has(id)) {
      indexById.set(id, result.length);
      result.push(record);
      return;
    }
    const index = indexById.get(id);
    if (localRecordWins(record, result[index], id)) result[index] = record;
  });
  return result;
}

function settingRevisionTime(revision) {
  return activityTime(revision?.updatedAt || revision?.changedAt || revision?.createdAt);
}

function mergeSettings(remoteSettings = {}, patchSettings = null) {
  const remote = remoteSettings && typeof remoteSettings === "object" ? { ...remoteSettings } : {};
  if (!patchSettings) return remote;
  const fields = patchSettings.fields || {};
  const fieldRevisions = patchSettings.fieldRevisions || {};
  const revisions = { ...(remote.settingsFieldRevisions || {}) };
  Object.entries(fields).forEach(([key, value]) => {
    const localRevision = fieldRevisions[key] || {
      updatedAt: patchSettings.updatedAt,
      updatedBy: patchSettings.updatedBy,
      deviceId: patchSettings.deviceId
    };
    const remoteRevision = revisions[key] || {};
    const localTime = settingRevisionTime(localRevision);
    const remoteTime = settingRevisionTime(remoteRevision);
    const localTie = `${localRevision.deviceId || ""}|${key}|${localRevision.updatedBy || ""}`;
    const remoteTie = `${remoteRevision.deviceId || ""}|${key}|${remoteRevision.updatedBy || ""}`;
    if (!(key in remote) || localTime > remoteTime || (localTime === remoteTime && localTie >= remoteTie)) {
      remote[key] = value;
      revisions[key] = localRevision;
    }
  });
  if (Object.keys(revisions).length) remote.settingsFieldRevisions = revisions;
  return remote;
}

function mergePatchIntoState(currentState = {}, patch = {}) {
  const merged = { ...(currentState || {}) };
  BUSINESS_COLLECTIONS.forEach(collectionName => {
    merged[collectionName] = mergeList(merged[collectionName], patch.changes?.[collectionName], collectionName);
  });
  merged.settings = mergeSettings(merged.settings || {}, patch.settings || null);
  return merged;
}

// The client (logAction() in index.html) already strips the heavy "undo" snapshot off activity log
// entries beyond the most recent UNDO_SNAPSHOT_RETENTION_COUNT (200) whenever IT creates a new entry,
// but that only prunes whatever that one browser session happens to have loaded locally at the time.
// It does nothing for entries other sessions/devices wrote, so undo bloat quietly re-accumulates over
// time (measured 2026-09-01: 39.87MB of undo snapshots on 369 entries older than the newest 200, out
// of a ~51MB total state -- the dominant cost of every full-state load, including sign-in). Doing the
// same trim here, server-side, on every save guarantees it never re-accumulates regardless of which
// client wrote the patch, so admins no longer need to remember to click "Clean Up Old Undo Data".
// Text history (everything except .undo) is always kept; only the ability to undo very old entries is
// removed, same as the manual cleanup button.
const UNDO_SNAPSHOT_RETENTION_COUNT = 200;
function trimActivityLogUndoHistory(activityLogs) {
  const logs = Array.isArray(activityLogs) ? activityLogs : [];
  if (logs.length <= UNDO_SNAPSHOT_RETENTION_COUNT) return logs;
  const sortedByRecency = [...logs].sort((a, b) => String(b?.createdAt || "").localeCompare(String(a?.createdAt || "")));
  const keepUndoIds = new Set(sortedByRecency.slice(0, UNDO_SNAPSHOT_RETENTION_COUNT).map(log => log?.id));
  return logs.map(log => {
    if (!log || !log.undo || keepUndoIds.has(log.id)) return log;
    const { undo, ...withoutUndo } = log;
    return withoutUndo;
  });
}

function dateOnly(value) {
  return String(value || "").slice(0, 10);
}

function minutes(value) {
  const [hh, mm] = String(value || "").split(":").map(Number);
  return (hh || 0) * 60 + (mm || 0);
}

function dateRangesOverlap(a = {}, b = {}) {
  const aStart = dateOnly(a.startDate) || "0000-01-01";
  const aEnd = dateOnly(a.endDate) || "9999-12-31";
  const bStart = dateOnly(b.startDate) || "0000-01-01";
  const bEnd = dateOnly(b.endDate) || "9999-12-31";
  return aStart <= bEnd && bStart <= aEnd;
}

function timeRangesOverlap(a = {}, b = {}) {
  const aStart = minutes(a.time || a.startTime);
  const bStart = minutes(b.time || b.startTime);
  const aEnd = aStart + Math.max(1, Number(a.minutes || a.duration || 30));
  const bEnd = bStart + Math.max(1, Number(b.minutes || b.duration || 30));
  return aStart < bEnd && bStart < aEnd;
}

function activeScheduleRecord(record) {
  return Boolean(record) && !record.archived && !record.deleted && record.status !== "deleted";
}

function openSlotCoversStudentSlot(slot = {}, studentSlot = {}) {
  if (!activeScheduleRecord(slot)) return false;
  if (slot.locked || slot.studentId || slot.studentName) return false;
  if (slot.unavailable || String(slot.status || "").toLowerCase() === "off") return false;
  if (String(slot.day || slot.weekday || "") !== String(studentSlot.day || "")) return false;
  if (!timeRangesOverlap(slot, studentSlot)) return false;
  if (!dateRangesOverlap(slot, studentSlot)) return false;
  const slotStart = dateOnly(slot.startDate);
  const slotEnd = dateOnly(slot.endDate);
  const studentStart = dateOnly(studentSlot.startDate);
  const studentEnd = dateOnly(studentSlot.endDate) || "9999-12-31";
  if (slotStart && studentStart && slotStart > studentStart) return false;
  if (slotEnd && slotEnd < studentEnd) return false;
  return true;
}

function validatePatchedStudentRegularSlots(mergedState = {}, patch = {}, currentState = {}) {
  const patchedStudents = Array.isArray(patch.changes?.students) ? patch.changes.students : [];
  if (!patchedStudents.length) return null;
  const teachersById = new Map((mergedState.teachers || []).map(teacher => [String(teacher.id || ""), teacher]));
  const currentTeachersById = new Map((currentState.teachers || []).map(teacher => [String(teacher.id || ""), teacher]));
  for (const student of patchedStudents) {
    for (const studentSlot of (student.regularSlots || [])) {
      if (!activeScheduleRecord(studentSlot) || !studentSlot.teacherId || !studentSlot.day || !studentSlot.time) continue;
      const teacher = teachersById.get(String(studentSlot.teacherId || ""));
      const currentTeacher = currentTeachersById.get(String(studentSlot.teacherId || ""));
      if (!teacher || teacher.archived || teacher.deleted || teacher.status === "disabled") {
        return {
          teacherId: studentSlot.teacherId,
          day: studentSlot.day,
          time: studentSlot.time,
          error: "Selected teacher is no longer active."
        };
      }
      const hasExistingLinkedSlot = (currentTeacher?.regularSlots || []).some(slot => {
        if (!activeScheduleRecord(slot)) return false;
        if (!slot.locked) return false;
        if (String(slot.studentSlotId || "") !== String(studentSlot.id || "")) return false;
        if (String(slot.studentId || "") !== String(student.id || "")) return false;
        if (String(slot.day || slot.weekday || "") !== String(studentSlot.day || "")) return false;
        if (!dateRangesOverlap(slot, studentSlot)) return false;
        return timeRangesOverlap(slot, studentSlot);
      });
      const hasOpenSlot = (currentTeacher?.regularSlots || teacher.regularSlots || []).some(slot => openSlotCoversStudentSlot(slot, studentSlot));
      if (!hasExistingLinkedSlot && !hasOpenSlot) {
        return {
          teacherId: studentSlot.teacherId,
          day: studentSlot.day,
          time: studentSlot.time,
          error: `${teacher.name || teacher.teacherName || "Teacher"} is not available on ${studentSlot.day} at ${studentSlot.time} for the selected regular class period.`
        };
      }
      const conflict = (teacher.regularSlots || []).find(slot => {
        if (!activeScheduleRecord(slot)) return false;
        if (!slot.locked || !slot.studentId) return false;
        if (String(slot.studentSlotId || "") === String(studentSlot.id || "")) return false;
        if (String(slot.studentId || "") === String(student.id || "")) return false;
        if (String(slot.day || slot.weekday || "") !== String(studentSlot.day || "")) return false;
        if (!dateRangesOverlap(slot, studentSlot)) return false;
        return timeRangesOverlap(slot, studentSlot);
      });
      if (conflict) {
        return {
          teacherId: studentSlot.teacherId,
          day: studentSlot.day,
          time: studentSlot.time,
          conflictingStudentName: conflict.studentName || "",
          conflictingClassType: conflict.type || "regular class",
          error: `${teacher.name || teacher.teacherName || "Teacher"} already has ${conflict.studentName || "another student"} on ${studentSlot.day} at ${studentSlot.time}.`
        };
      }
    }
  }
  return null;
}

function splitText(text, chunkSize = 350000) {
  const chunks = [];
  for (let index = 0; index < text.length; index += chunkSize) chunks.push(text.slice(index, index + chunkSize));
  return chunks.length ? chunks : [""];
}

function affectedTeacherIdsFromPatch(patch = {}) {
  const ids = new Set();
  ["bookings", "replacements", "teacherLeaves", "teacherFeedback"].forEach(collectionName => {
    (patch.changes?.[collectionName] || []).forEach(record => {
      if (record?.teacherId) ids.add(String(record.teacherId));
      if (record?.replacementTeacherId) ids.add(String(record.replacementTeacherId));
      if (record?.originalTeacherId) ids.add(String(record.originalTeacherId));
    });
  });
  (patch.changes?.teachers || []).forEach(record => record?.id && ids.add(String(record.id)));
  return [...ids];
}

async function applyPatch(req, res) {
  await ensureCoreTables();
  const body = await readJson(req);
  const key = stateKey(req, body);
  const patch = body.patch;
  const updatedBy = String(body.updatedBy || "app").slice(0, 120);
  if (!patch || patch.format !== "classone_record_patch_v1" || typeof patch !== "object") {
    return sendJson(res, 400, { ok: false, error: "Body must include a classone_record_patch_v1 patch." });
  }

  const sql = getSql();
  const rows = await sql`select data, version from app_state where key = ${key} limit 1`;
  const currentState = rows.length ? (rows[0].data || {}) : {};
  const currentVersion = rows.length ? Number(rows[0].version || 0) : 0;
  const email = verifiedSessionEmail(req, body);
  // userCanWrite/userCanManageUsers check against loadUsersAndRolesForPermissionCheck()'s merged
  // users/roles, not currentState.users/.roles directly -- currentState is the raw legacy blob, which
  // doesn't see a user only created/edited through the newer collection_records_v2 "users" sync path
  // (see that function's comment: the same gap broke login for Kelvin, 2026-09-03, and would equally
  // deny a valid save here with "You do not have permission" for such a user). currentState itself is
  // still used unmodified below for the actual patch merge.
  const permissionState = await loadUsersAndRolesForPermissionCheck(key);
  if (!userCanWrite(permissionState, email)) {
    return sendJson(res, 403, { ok: false, error: "You do not have permission to save changes." });
  }
  if (usersOrRolesPatched(patch) && !userCanManageUsers(permissionState, email)) {
    return sendJson(res, 403, { ok: false, error: "Only master_admin can manage users and roles." });

  const merged = mergePatchIntoState(currentState, patch);
  merged.activityLogs = trimActivityLogUndoHistory(merged.activityLogs);
  const regularSlotConflict = validatePatchedStudentRegularSlots(merged, patch, currentState);
  if (regularSlotConflict) {
    return sendJson(res, 409, {
      ok: false,
      error: regularSlotConflict.error || "Teacher regular slot conflict.",
      conflict: regularSlotConflict,
      currentVersion
    });
  }
  const expectedVersion = currentVersion;
  const chunks = splitText(JSON.stringify(merged));
  const publishedChunks = JSON.stringify(chunks.map((chunk, index) => ({
    chunk_index: index,
    chunk_data: chunk
  })));
  const savedRows = await sql`
    with saved as (
      insert into app_state (key, data, version, updated_by)
      values (${key}, ${JSON.stringify(merged)}::jsonb, 1, ${updatedBy})
      on conflict (key) do update
      set data = excluded.data,
          version = app_state.version + 1,
          updated_at = now(),
          updated_by = excluded.updated_by
      where app_state.version = ${expectedVersion}
      returning key, version, updated_at, updated_by
    ),
    removed_old_chunks as (
      delete from app_state_text_chunks chunks
      where chunks.state_key = ${key}
        and exists (select 1 from saved)
      returning chunks.state_key
    ),
    inserted_chunks as (
      insert into app_state_text_chunks (state_key, version, chunk_index, chunk_data)
      select saved.key,
             saved.version,
             (item ->> 'chunk_index')::integer,
             item ->> 'chunk_data'
      from saved
      cross join jsonb_array_elements(${publishedChunks}::jsonb) item
      returning chunk_index
    )
    select saved.key,
           saved.version,
           saved.updated_at,
           saved.updated_by,
           (select count(*)::int from inserted_chunks) as published_chunks
    from saved
  `;
  if (!savedRows.length) {
    const current = await sql`select version from app_state where key = ${key} limit 1`;
    return sendJson(res, 409, {
      ok: false,
      error: "Version conflict. Please retry with the latest data.",
      currentVersion: current.length ? Number(current[0].version || 0) : 0
    });
  }
  const saved = savedRows[0];
  const totalChunks = Number(saved.published_chunks || 0);
  if (totalChunks !== chunks.length) {
    throw new Error(`Patch chunk publication failed. Published ${totalChunks} of ${chunks.length}.`);
  }
  const affectedTeacherIds = affectedTeacherIdsFromPatch(patch);
  await sql`
    insert into audit_logs (action, entity_type, entity_id, summary, after_data, created_by)
    values (
      'app_state_patch_saved',
      'app_state',
      ${key},
      ${`Patched app state ${key}`},
      ${JSON.stringify({ version: Number(saved.version || 0), affectedTeacherIds, totalChunks })}::jsonb,
      ${updatedBy}
    )
  `;
  return sendJson(res, 200, {
    ok: true,
    key: saved.key,
    version: Number(saved.version || 0),
    updatedAt: saved.updated_at,
    updatedBy: saved.updated_by || null,
    totalChunks,
    affectedTeacherIds,
    mergedFromNewerVersion: Number(patch.baseVersion || 0) !== currentVersion
  });
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;

  try {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    return await applyPatch(req, res);
  } catch (error) {
    const message = safeError(error);
    if (Number(error?.status || 0) === 413 || /request body is too large|request is too large|body exceeded/i.test(message)) {
      return sendJson(res, 413, {
        ok: false,
        code: "PATCH_PAYLOAD_TOO_LARGE",
        error: "Record patch payload is too large.",
        payloadBytes: Number(error?.payloadBytes || 0) || null,
        maxBytes: Number(error?.maxBytes || 0) || 67108864,
        retryable: false
      });
    }
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
