const { loadComposedState, loadLegacyState, normalizedRows, stateKey, dateOnly, timeOnly } = require("../lib/composed-state");
const calendarResolver = require("../lib/calendar-resolver");
const { setCors, sendJson, handleOptions, requireApiKey, safeError } = require("../lib/http");

function normalizeName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function addDays(dateISO, amount) {
  const date = new Date(`${dateISO}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dayName(dateISO) {
  return calendarResolver.dayName(dateISO);
}

function sameTeacher(record, teacher) {
  if (!teacher) return true;
  return String(record.teacherId || "") === String(teacher.id || "");
}

function sameStudent(record, studentName, studentId = "") {
  const targetName = normalizeName(studentName);
  if (!targetName && !studentId) return true;
  if (studentId && String(record.studentId || "") === String(studentId)) return true;
  return targetName && normalizeName(record.studentName || record.childName || record.name) === targetName;
}

function sameDateTime(record, dateISO, targetTime) {
  const recordDate = dateOnly(record.date || record.classDate || record.originalDate || record.startDate || "");
  const recordTime = timeOnly(record.time || record.classTime || record.originalTime || "");
  return recordDate === dateISO && recordTime === targetTime;
}

function assignmentApplies(record, teacher, studentName, studentId, dateISO, targetTime) {
  if (!sameTeacher(record, teacher)) return false;
  if (!sameStudent(record, studentName, studentId)) return false;
  const recordTime = timeOnly(record.time || record.classTime || "");
  if (recordTime !== targetTime) return false;
  const weekday = record.day || record.weekday || "";
  if (weekday && weekday !== dayName(dateISO)) return false;
  const startDate = dateOnly(record.startDate || "");
  const endDate = dateOnly(record.endDate || record.lastClassDate || "");
  if (startDate && startDate > dateISO) return false;
  if (endDate && endDate < dateISO) return false;
  return true;
}

function safeRecord(source, record, extra = {}) {
  const raw = record || {};
  return {
    source,
    table: source,
    id: raw.id || raw.assignmentId || raw.bookingId || raw.creditId || raw.replacementId || "",
    bookingId: raw.bookingId || raw.id || "",
    occurrenceId: raw.occurrenceId || raw.sourceOccurrenceId || "",
    occurrenceKey: raw.occurrenceKey || raw.sourceOccurrenceKey || "",
    normalizedRecurringAssignmentId: raw.normalizedRecurringAssignmentId || "",
    assignmentId: raw.assignmentId || "",
    recurringAssignmentId: raw.recurringAssignmentId || "",
    recurringSourceSlotId: raw.recurringSourceSlotId || "",
    sourceSlotId: raw.sourceSlotId || "",
    recurringScheduleId: raw.recurringScheduleId || "",
    movedFromRecurringClassId: raw.movedFromRecurringClassId || "",
    teacherId: raw.teacherId || "",
    studentId: raw.studentId || "",
    studentName: raw.studentName || raw.childName || raw.name || "",
    date: dateOnly(raw.date || raw.classDate || raw.originalDate || extra.date || ""),
    time: timeOnly(raw.time || raw.classTime || raw.originalTime || extra.time || ""),
    weekday: raw.day || raw.weekday || (extra.date ? dayName(extra.date) : ""),
    classType: raw.type || raw.classType || "",
    subject: raw.subject || "",
    status: raw.status || "",
    outcome: raw.outcome || "",
    classOutcome: raw.classOutcome || "",
    resolutionStatus: raw.resolutionStatus || "",
    resolutionOutcome: raw.resolutionOutcome || "",
    resolutionActive: raw.resolutionActive === true,
    suppressRecurringOccurrence: raw.suppressRecurringOccurrence === true,
    createdAt: raw.createdAt || raw.created_at || "",
    updatedAt: raw.updatedAt || raw.updated_at || "",
    cancelledAt: raw.cancelledAt || "",
    completedAt: raw.completedAt || "",
    finalizedAt: raw.finalizedAt || "",
    restoredAt: raw.restoredAt || "",
    recordVersion: Number(raw.recordVersion || 0),
    systemVersion: Number(raw.systemVersion || extra.systemVersion || 0),
    supersededBy: raw.supersededBy || raw.supersededByBookingId || "",
    rebookedBy: raw.rebookedBy || raw.rebookedByBookingId || "",
    deleted: raw.deleted === true || raw.status === "deleted",
    archived: raw.archived === true,
    raw
  };
}

function bookingCandidate(source, booking, teacher, studentName, studentId, dateISO, targetTime, systemVersion) {
  if (!sameTeacher(booking, teacher) || !sameStudent(booking, studentName, studentId) || !sameDateTime(booking, dateISO, targetTime)) return null;
  const record = safeRecord(source, booking, { systemVersion });
  record.occurrenceKey = record.occurrenceKey || calendarResolver.occurrenceKeyForBooking(booking);
  record.occurrenceId = record.occurrenceId || calendarResolver.occurrenceIdForBooking(booking);
  return record;
}

function slotCandidate(source, slot, teacher, studentName, studentId, dateISO, targetTime, systemVersion) {
  if (!assignmentApplies({ ...slot, teacherId: slot.teacherId || teacher?.id || "" }, teacher, studentName, studentId, dateISO, targetTime)) return null;
  const record = safeRecord(source, { ...slot, teacherId: slot.teacherId || teacher?.id || "", date: dateISO, time: slot.time || slot.classTime }, { date: dateISO, time: targetTime, systemVersion });
  record.bookingId = "";
  record.occurrenceKey = record.occurrenceKey || calendarResolver.occurrenceKeyForSlot({ ...slot, teacherId: record.teacherId, date: dateISO }, dateISO);
  record.occurrenceId = record.occurrenceId || calendarResolver.occurrenceIdForSlot({ ...slot, teacherId: record.teacherId, date: dateISO }, dateISO);
  return record;
}

function replacementCandidate(source, item, candidateIds, teacher, studentName, studentId, dateISO, targetTime, systemVersion) {
  const ids = [
    item.bookingId,
    item.sourceBookingId,
    item.originalBookingId,
    item.replacementBookingId
  ].filter(Boolean).map(String);
  const linked = ids.some(id => candidateIds.has(id));
  const direct = sameTeacher(item, teacher) && sameStudent(item, studentName, studentId) && sameDateTime(item, dateISO, targetTime);
  if (!linked && !direct) return null;
  return safeRecord(source, item, { systemVersion });
}

function findTeacher(data, teacherName, teacherId) {
  const teachers = Array.isArray(data?.teachers) ? data.teachers : [];
  if (teacherId) return teachers.find(teacher => String(teacher.id || "") === String(teacherId)) || null;
  const query = normalizeName(teacherName);
  return teachers.find(teacher => normalizeName(teacher.name || "") === query) ||
    teachers.find(teacher => normalizeName(teacher.name || "").includes(query)) ||
    null;
}

function findStudent(data, studentName, studentId) {
  const students = Array.isArray(data?.students) ? data.students : [];
  if (studentId) return students.find(student => String(student.id || "") === String(studentId)) || null;
  const query = normalizeName(studentName);
  return students.find(student => normalizeName(student.name || "") === query) ||
    students.find(student => normalizeName(student.name || "").includes(query)) ||
    null;
}

function resolvedCellSummary(cell) {
  if (!cell) return null;
  return {
    cellKey: cell.cellKey || calendarResolver.teacherDateTimeKey(cell.teacherId, cell.date, cell.time),
    source: cell.source || "",
    kind: cell.kind || "",
    sourceRecordId: cell.sourceRecordId || "",
    bookingId: cell.bookingId || "",
    occurrenceId: cell.occurrenceId || "",
    occurrenceKey: cell.occurrenceKey || "",
    recurringScheduleId: cell.recurringScheduleId || "",
    sourceSlotId: cell.sourceSlotId || "",
    teacherId: cell.teacherId || "",
    studentId: cell.studentId || "",
    studentName: cell.studentName || "",
    date: dateOnly(cell.date || ""),
    time: timeOnly(cell.time || ""),
    subject: cell.subject || "",
    classType: cell.type || "",
    status: cell.status || "",
    available: Boolean(cell.available),
    locked: Boolean(cell.locked),
    updatedAt: cell.updatedAt || "",
    raw: cell
  };
}

function buildWinnerTrace(candidates, finalWinner) {
  return {
    candidates,
    finalWinner,
    note: "Candidate selection uses the shared calendar resolver result. For per-record booking tie reasons, inspect bookingResolutionDiagnostics."
  };
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
  if (String(req.query.debugSync || "") !== "1") return sendJson(res, 403, { ok: false, error: "debugSync=1 is required for this read-only inspector." });

  try {
    const key = stateKey(req);
    const teacherName = String(req.query.teacherName || "");
    const teacherId = String(req.query.teacherId || "");
    const studentName = String(req.query.studentName || "");
    const studentIdQuery = String(req.query.studentId || "");
    const dateISO = dateOnly(req.query.date || "");
    const targetTime = timeOnly(req.query.time || "");
    if (!dateISO || !targetTime || (!teacherName && !teacherId)) {
      return sendJson(res, 400, { ok: false, error: "teacherName or teacherId, date, and time are required." });
    }

    const [legacy, composed] = await Promise.all([
      loadLegacyState(key),
      loadComposedState(key)
    ]);
    const normalized = composed.normalized || await normalizedRows(key);
    const data = composed.data || legacy.data || {};
    const teacher = findTeacher(data, teacherName, teacherId);
    const student = findStudent(data, studentName, studentIdQuery);
    const studentId = studentIdQuery || student?.id || "";
    if (!teacher) return sendJson(res, 404, { ok: false, error: "Teacher not found in composed state." });

    const candidateIds = new Set();
    const legacyBookings = (legacy.data?.bookings || [])
      .map(booking => bookingCandidate("app_state.bookings", booking, teacher, studentName, studentId, dateISO, targetTime, legacy.version))
      .filter(Boolean);
    legacyBookings.forEach(item => candidateIds.add(String(item.bookingId || item.id || "")));

    const normalizedBookings = (normalized.bookings || [])
      .map(booking => bookingCandidate("booking_records_v2", booking, teacher, studentName, studentId, dateISO, targetTime, normalized.systemVersion))
      .filter(Boolean);
    normalizedBookings.forEach(item => candidateIds.add(String(item.bookingId || item.id || "")));

    const legacyTeacher = (legacy.data?.teachers || []).find(item => String(item.id || "") === String(teacher.id || "")) || teacher;
    const legacyRecurring = [
      ...(legacyTeacher?.regularSlots || []).map(slot => slotCandidate("app_state.teachers.regularSlots", slot, legacyTeacher, studentName, studentId, dateISO, targetTime, legacy.version)),
      ...(legacyTeacher?.overrideSlots || []).map(slot => slotCandidate("app_state.teachers.overrideSlots", slot, legacyTeacher, studentName, studentId, dateISO, targetTime, legacy.version))
    ].filter(Boolean);

    const normalizedRecurring = (normalized.recurringAssignments || [])
      .map(slot => slotCandidate("recurring_assignments_v2", slot, teacher, studentName, studentId, dateISO, targetTime, normalized.systemVersion))
      .filter(Boolean);

    const legacyStudents = (legacy.data?.students || [])
      .filter(stu => !studentId || String(stu.id || "") === String(studentId) || normalizeName(stu.name || "") === normalizeName(studentName))
      .flatMap(stu => (stu.regularSlots || []).map(slot => slotCandidate("app_state.students.regularSlots", { ...slot, studentId: stu.id, studentName: stu.name }, teacher, studentName, studentId, dateISO, targetTime, legacy.version)))
      .filter(Boolean);

    const composedBookings = (data.bookings || [])
      .map(booking => bookingCandidate("composed_state.bookings", booking, teacher, studentName, studentId, dateISO, targetTime, composed.version))
      .filter(Boolean);

    const generatedCalendar = calendarResolver.resolveTeacherCalendar(data, {
      teacher,
      teacherId: teacher.id,
      from: dateISO,
      to: dateISO,
      stateVersion: composed.version
    });
    const cellKey = calendarResolver.teacherDateTimeKey(teacher.id, dateISO, targetTime);
    const resolvedCell = generatedCalendar.cells.find(cell =>
      (cell.cellKey || calendarResolver.teacherDateTimeKey(cell.teacherId, cell.date, cell.time)) === cellKey
    ) || null;

    const linkedIds = new Set([...candidateIds, ...composedBookings.map(item => item.bookingId || item.id).filter(Boolean)]);
    const legacyReplacements = (legacy.data?.replacements || [])
      .map(item => replacementCandidate("app_state.replacements", item, linkedIds, teacher, studentName, studentId, dateISO, targetTime, legacy.version))
      .filter(Boolean);
    const legacyCredits = (legacy.data?.replacementCredits || [])
      .map(item => replacementCandidate("app_state.replacementCredits", item, linkedIds, teacher, studentName, studentId, dateISO, targetTime, legacy.version))
      .filter(Boolean);
    const normalizedReplacements = (normalized.replacements || [])
      .map(item => replacementCandidate("replacement_records_v2", item, linkedIds, teacher, studentName, studentId, dateISO, targetTime, normalized.systemVersion))
      .filter(Boolean);
    const normalizedCredits = (normalized.replacementCredits || [])
      .map(item => replacementCandidate("replacement_credit_records_v2", item, linkedIds, teacher, studentName, studentId, dateISO, targetTime, normalized.systemVersion))
      .filter(Boolean);

    const siblingDates = [-2, -1, 0].map(offset => addDays(dateISO, offset));
    const siblingOccurrences = siblingDates.map(day => {
      const resolved = calendarResolver.resolveTeacherCalendar(data, { teacher, teacherId: teacher.id, from: day, to: day, stateVersion: composed.version });
      return {
        date: day,
        time: targetTime,
        finalCell: resolvedCellSummary(resolved.cells.find(cell =>
          String(cell.studentName || "").toLowerCase().includes(normalizeName(studentName)) &&
          timeOnly(cell.time) === targetTime
        ) || null)
      };
    });

    const allCandidates = [
      ...legacyBookings,
      ...normalizedBookings,
      ...legacyRecurring,
      ...legacyStudents,
      ...normalizedRecurring,
      ...composedBookings,
      ...legacyReplacements,
      ...legacyCredits,
      ...normalizedReplacements,
      ...normalizedCredits
    ];

    const response = {
      ok: true,
      readOnly: true,
      generatedAt: new Date().toISOString(),
      key,
      query: {
        teacherName,
        teacherId: teacher.id,
        studentName,
        studentId,
        date: dateISO,
        time: targetTime,
        weekday: dayName(dateISO)
      },
      versions: {
        legacyAppStateVersion: Number(legacy.version || 0),
        composedVersion: Number(composed.version || 0),
        normalizedSystemVersion: Number(normalized.systemVersion || 0),
        updatedAt: composed.updatedAt || legacy.updatedAt || null
      },
      matchingRecords: {
        legacyBookings,
        normalizedBookings,
        legacyRecurringAssignments: legacyRecurring,
        studentRegularAssignments: legacyStudents,
        normalizedRecurringAssignments: normalizedRecurring,
        composedStateBookingCandidates: composedBookings,
        replacementTasks: [...legacyReplacements, ...normalizedReplacements],
        replacementCredits: [...legacyCredits, ...normalizedCredits],
        allCandidates
      },
      resolvedSources: {
        recurringCandidateGeneratedForDate: generatedCalendar.cells
          .filter(cell => cell.kind === "fixed" && timeOnly(cell.time) === targetTime)
          .map(resolvedCellSummary),
        exactDateOutcomeCandidates: composedBookings,
        weeklyTimetableCandidateList: allCandidates,
        teacherViewCandidateList: allCandidates,
        weeklyTimetableWinner: resolvedCellSummary(resolvedCell),
        teacherViewWinner: resolvedCellSummary(resolvedCell),
        weeklyWinnerTrace: buildWinnerTrace(allCandidates, resolvedCellSummary(resolvedCell)),
        teacherViewWinnerTrace: buildWinnerTrace(allCandidates, resolvedCellSummary(resolvedCell)),
        bookingResolutionDiagnostics: calendarResolver.bookingResolutionDiagnostics(data.bookings || [])
          .filter(item => String(item.slotKey || "").includes(`${teacher.id}|${dateISO}|${targetTime}`))
      },
      nearbyOccurrenceIdentity: siblingOccurrences,
      duplicateRecurringAssignments: normalizedRecurring.length + legacyRecurring.length > 1 ? [...legacyRecurring, ...normalizedRecurring] : [],
      duplicateCancellationRecords: allCandidates.filter(item => ["cancelled", "cancel"].includes(String(item.status || item.outcome || item.classOutcome || "").toLowerCase())),
      duplicateReplacementCredits: [...legacyCredits, ...normalizedCredits],
      instructions: "This endpoint is read-only. Do not cancel again until the returned object is reviewed."
    };

    return sendJson(res, 200, response);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
