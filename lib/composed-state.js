const crypto = require("node:crypto");
const { ensureCoreTables, getSql } = require("./db");

function stateKey(reqOrKey, body) {
  if (typeof reqOrKey === "string") return reqOrKey.trim() || "production";
  return String((body && body.key) || (reqOrKey && reqOrKey.query && reqOrKey.query.key) || "production").trim() || "production";
}

function dateOnly(value) {
  return String(value || "").slice(0, 10) || null;
}

function timeOnly(value) {
  return String(value || "").slice(0, 5) || "";
}

function normalizedId(record, prefix) {
  if (record && record.id) return String(record.id);
  if (record && record.bookingId) return String(record.bookingId);
  return `${prefix}_${crypto.createHash("sha1").update(JSON.stringify(record || {})).digest("hex")}`;
}

function recurringAssignmentId(record, teacher = null, collectionName = "regularSlots") {
  if (record && record.normalizedRecurringAssignmentId) return String(record.normalizedRecurringAssignmentId);
  if (record && record.assignmentId) return String(record.assignmentId);
  if (record && record.id) return String(record.id);
  const seed = {
    teacherId: record?.teacherId || teacher?.id || "",
    studentId: record?.studentId || "",
    studentName: record?.studentName || "",
    day: record?.day || record?.weekday || "",
    time: timeOnly(record?.time || record?.classTime),
    startDate: dateOnly(record?.startDate),
    collectionName
  };
  return `recurring_${crypto.createHash("sha1").update(JSON.stringify(seed)).digest("hex")}`;
}

function normalizeRecurringAssignment(record = {}, teacher = null, collectionName = "regularSlots") {
  const id = recurringAssignmentId(record, teacher, collectionName);
  const teacherId = String(record.teacherId || teacher?.id || "");
  const data = {
    ...record,
    id: String(record.id || record.sourceSlotId || id),
    assignmentId: id,
    normalizedRecurringAssignmentId: id,
    teacherId,
    day: record.day || record.weekday || "",
    weekday: record.weekday || record.day || "",
    time: timeOnly(record.time || record.classTime),
    subject: record.subject || "",
    type: record.type || "regular class",
    status: record.status || (record.deleted ? "deleted" : record.unavailable ? "off" : "active"),
    sourceCollection: record.sourceCollection || collectionName,
    sourceSlotId: record.sourceSlotId || record.id || "",
    studentSlotId: record.studentSlotId || "",
    recordVersion: Number(record.recordVersion || 1),
    createdAt: record.createdAt || new Date().toISOString(),
    updatedAt: record.updatedAt || record.changedAt || record.createdAt || new Date().toISOString()
  };
  return data;
}

function mergeById(baseList, overlayList, idName = "id") {
  const result = Array.isArray(baseList) ? baseList.map(item => ({ ...item })) : [];
  const indexById = new Map(result.map((item, index) => [String(item && item[idName] || ""), index]));
  (Array.isArray(overlayList) ? overlayList : []).forEach(item => {
    if (!item || typeof item !== "object") return;
    const id = String(item[idName] || "");
    if (!id) return;
    if (indexById.has(id)) result[indexById.get(id)] = { ...result[indexById.get(id)], ...item };
    else {
      indexById.set(id, result.length);
      result.push(item);
    }
  });
  return result;
}

async function loadLegacyState(key = "production") {
  await ensureCoreTables();
  const sql = getSql();
  const rows = await sql`
    select key, data, version, updated_at, updated_by
    from app_state
    where key = ${key}
    limit 1
  `;
  if (!rows.length) {
    return { key, data: null, version: 0, updatedAt: null, updatedBy: null };
  }
  return {
    key: rows[0].key,
    data: rows[0].data || {},
    version: Number(rows[0].version || 0),
    updatedAt: rows[0].updated_at,
    updatedBy: rows[0].updated_by || null
  };
}

async function backfillBookingsFromAppState(key = "production") {
  await ensureCoreTables();
  const sql = getSql();
  const rows = await sql`select data from app_state where key = ${key} limit 1`;
  const bookings = Array.isArray(rows[0]?.data?.bookings) ? rows[0].data.bookings : [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;
  for (const booking of bookings) {
    if (!booking || typeof booking !== "object") {
      skipped += 1;
      continue;
    }
    const id = normalizedId(booking, "booking");
    const data = { ...booking, id, bookingId: booking.bookingId || id };
    const existing = await sql`
      select data
      from booking_records_v2
      where state_key = ${key} and booking_id = ${id}
      limit 1
    `;
    if (!existing.length) {
      await sql`
        insert into booking_records_v2 (state_key, booking_id, teacher_id, student_id, class_date, class_time, status, record_version, data)
        values (
          ${key},
          ${id},
          ${data.teacherId || ""},
          ${data.studentId || ""},
          ${dateOnly(data.date)},
          ${timeOnly(data.time)},
          ${data.status || "booked"},
          ${Number(data.recordVersion || 1)},
          ${JSON.stringify({ ...data, recordVersion: Number(data.recordVersion || 1) })}::jsonb
        )
      `;
      inserted += 1;
      continue;
    }
    const existingVersion = Number(existing[0].data?.recordVersion || 1);
    const incomingVersion = Number(data.recordVersion || 1);
    if (incomingVersion > existingVersion) {
      await sql`
        update booking_records_v2
        set teacher_id = ${data.teacherId || ""},
            student_id = ${data.studentId || ""},
            class_date = ${dateOnly(data.date)},
            class_time = ${timeOnly(data.time)},
            status = ${data.status || "booked"},
            record_version = ${incomingVersion},
            data = ${JSON.stringify({ ...data, recordVersion: incomingVersion })}::jsonb,
            updated_at = now()
        where state_key = ${key} and booking_id = ${id}
      `;
      updated += 1;
    } else if (JSON.stringify(existing[0].data || {}) !== JSON.stringify(data || {})) {
      conflicts += 1;
    } else {
      skipped += 1;
    }
  }
  return { sourceBookingCount: bookings.length, inserted, updated, skipped, duplicateConflictCount: conflicts };
}

async function backfillRecurringAssignmentsFromAppState(key = "production") {
  await ensureCoreTables();
  const sql = getSql();
  const rows = await sql`select data from app_state where key = ${key} limit 1`;
  const teachers = Array.isArray(rows[0]?.data?.teachers) ? rows[0].data.teachers : [];
  let sourceAssignmentCount = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;
  for (const teacher of teachers) {
    for (const collectionName of ["regularSlots", "overrideSlots"]) {
      const slots = Array.isArray(teacher?.[collectionName]) ? teacher[collectionName] : [];
      for (const slot of slots) {
        if (!slot || typeof slot !== "object") {
          skipped += 1;
          continue;
        }
        if (!slot.day && !slot.weekday) {
          skipped += 1;
          continue;
        }
        sourceAssignmentCount += 1;
        const data = normalizeRecurringAssignment(slot, teacher, collectionName);
        const id = data.assignmentId;
        const existing = await sql`
          select data
          from recurring_assignments_v2
          where state_key = ${key} and assignment_id = ${id}
          limit 1
        `;
        if (!existing.length) {
          await sql`
            insert into recurring_assignments_v2 (
              state_key, assignment_id, teacher_id, student_id, weekday, class_time, status,
              source_collection, source_slot_id, student_slot_id, record_version, data
            )
            values (
              ${key}, ${id}, ${data.teacherId || ""}, ${data.studentId || ""}, ${data.day || data.weekday || ""},
              ${timeOnly(data.time)}, ${data.status || "active"}, ${data.sourceCollection || collectionName},
              ${data.sourceSlotId || ""}, ${data.studentSlotId || ""}, ${Number(data.recordVersion || 1)},
              ${JSON.stringify(data)}::jsonb
            )
          `;
          inserted += 1;
          continue;
        }
        const existingVersion = Number(existing[0].data?.recordVersion || 1);
        const incomingVersion = Number(data.recordVersion || 1);
        if (incomingVersion > existingVersion) {
          await sql`
            update recurring_assignments_v2
            set teacher_id = ${data.teacherId || ""},
                student_id = ${data.studentId || ""},
                weekday = ${data.day || data.weekday || ""},
                class_time = ${timeOnly(data.time)},
                status = ${data.status || "active"},
                source_collection = ${data.sourceCollection || collectionName},
                source_slot_id = ${data.sourceSlotId || ""},
                student_slot_id = ${data.studentSlotId || ""},
                record_version = ${incomingVersion},
                data = ${JSON.stringify({ ...data, recordVersion: incomingVersion })}::jsonb,
                updated_at = now()
            where state_key = ${key} and assignment_id = ${id}
          `;
          updated += 1;
        } else if (JSON.stringify(existing[0].data || {}) !== JSON.stringify(data || {})) {
          conflicts += 1;
        } else {
          skipped += 1;
        }
      }
    }
  }
  return { sourceAssignmentCount, inserted, updated, skipped, duplicateConflictCount: conflicts };
}

async function recurringAssignmentBackfillStatus(key = "production") {
  await ensureCoreTables();
  const sql = getSql();
  const rows = await sql`select data from app_state where key = ${key} limit 1`;
  const teachers = Array.isArray(rows[0]?.data?.teachers) ? rows[0].data.teachers : [];
  const legacyAssignments = [];
  teachers.forEach(teacher => {
    ["regularSlots", "overrideSlots"].forEach(collectionName => {
      (Array.isArray(teacher?.[collectionName]) ? teacher[collectionName] : []).forEach(slot => {
        if (slot?.day || slot?.weekday) legacyAssignments.push(normalizeRecurringAssignment(slot, teacher, collectionName));
      });
    });
  });
  const legacyIds = legacyAssignments.map(item => item.assignmentId);
  const uniqueLegacyIds = new Set(legacyIds);
  const duplicateLegacyAssignmentCount = legacyIds.length - uniqueLegacyIds.size;
  const normalized = await sql`
    select assignment_id, data, created_at, updated_at
    from recurring_assignments_v2
    where state_key = ${key}
  `;
  const normalizedById = new Map(normalized.map(row => [String(row.assignment_id || ""), row]));
  let missingNormalizedAssignmentCount = 0;
  let duplicateConflictCount = duplicateLegacyAssignmentCount;
  legacyAssignments.forEach(item => {
    const row = normalizedById.get(item.assignmentId);
    if (!row) {
      missingNormalizedAssignmentCount += 1;
      return;
    }
    const existingVersion = Number(row.data?.recordVersion || 1);
    const incomingVersion = Number(item.recordVersion || 1);
    if (incomingVersion <= existingVersion && JSON.stringify(row.data || {}) !== JSON.stringify(item || {})) duplicateConflictCount += 1;
  });
  const lastBackfillTimestamp = normalized.reduce((latest, row) => {
    const value = row.updated_at || row.created_at;
    if (!value) return latest;
    const iso = new Date(value).toISOString();
    return !latest || iso > latest ? iso : latest;
  }, "");
  return {
    legacyRecurringAssignmentCount: legacyAssignments.length,
    normalizedRecurringAssignmentCount: normalized.length,
    missingNormalizedAssignmentCount,
    duplicateConflictCount,
    duplicateLegacyAssignmentCount,
    lastBackfillTimestamp: lastBackfillTimestamp || null,
    ready: legacyAssignments.length > 0 && missingNormalizedAssignmentCount === 0
  };
}

async function bookingBackfillStatus(key = "production") {
  await ensureCoreTables();
  const sql = getSql();
  const rows = await sql`select data from app_state where key = ${key} limit 1`;
  const legacyBookings = Array.isArray(rows[0]?.data?.bookings) ? rows[0].data.bookings : [];
  const legacyIds = legacyBookings.map(booking => normalizedId(booking, "booking"));
  const uniqueLegacyIds = new Set(legacyIds);
  const duplicateLegacyBookingCount = legacyIds.length - uniqueLegacyIds.size;
  const normalized = await sql`
    select booking_id, data, created_at, updated_at
    from booking_records_v2
    where state_key = ${key}
  `;
  const normalizedById = new Map(normalized.map(row => [String(row.booking_id || ""), row]));
  let missingNormalizedBookingCount = 0;
  let duplicateConflictCount = duplicateLegacyBookingCount;
  for (const booking of legacyBookings) {
    const id = normalizedId(booking, "booking");
    const row = normalizedById.get(id);
    if (!row) {
      missingNormalizedBookingCount += 1;
      continue;
    }
    const data = { ...booking, id, bookingId: booking.bookingId || id };
    const existingVersion = Number(row.data?.recordVersion || 1);
    const incomingVersion = Number(data.recordVersion || 1);
    if (incomingVersion <= existingVersion && JSON.stringify(row.data || {}) !== JSON.stringify(data || {})) {
      duplicateConflictCount += 1;
    }
  }
  const lastBackfillTimestamp = normalized.reduce((latest, row) => {
    const value = row.updated_at || row.created_at;
    if (!value) return latest;
    const iso = new Date(value).toISOString();
    return !latest || iso > latest ? iso : latest;
  }, "");
  return {
    legacyBookingCount: legacyBookings.length,
    normalizedBookingCount: normalized.length,
    missingNormalizedBookingCount,
    duplicateConflictCount,
    duplicateLegacyBookingCount,
    lastBackfillTimestamp: lastBackfillTimestamp || null,
    ready: legacyBookings.length > 0 && missingNormalizedBookingCount === 0
  };
}

async function normalizedRows(key = "production") {
  await ensureCoreTables();
  const sql = getSql();
  const [bookingRows, recurringRows, replacementRows, creditRows, activityRows, versionRows] = await Promise.all([
    sql`select data from booking_records_v2 where state_key = ${key}`,
    sql`select data from recurring_assignments_v2 where state_key = ${key}`,
    sql`select data from replacement_records_v2 where state_key = ${key}`,
    sql`select data from replacement_credit_records_v2 where state_key = ${key}`,
    sql`select data from activity_events_v2 where state_key = ${key} order by created_at desc limit 2500`,
    sql`select version, updated_at from system_versions where state_key = ${key} limit 1`
  ]);
  return {
    bookings: bookingRows.map(row => row.data),
    recurringAssignments: recurringRows.map(row => row.data),
    replacements: replacementRows.map(row => row.data),
    replacementCredits: creditRows.map(row => row.data),
    activityLogs: activityRows.map(row => row.data),
    systemVersion: Number(versionRows[0]?.version || 0),
    systemUpdatedAt: versionRows[0]?.updated_at || null
  };
}

function overlayRecurringAssignments(data, assignments = []) {
  if (!data || !Array.isArray(assignments) || !assignments.length) return data;
  data.teachers ||= [];
  data.students ||= [];
  const teachersById = new Map(data.teachers.map(teacher => [String(teacher.id || ""), teacher]));
  const studentsById = new Map(data.students.map(student => [String(student.id || ""), student]));
  assignments.forEach(raw => {
    if (!raw || typeof raw !== "object") return;
    const assignment = normalizeRecurringAssignment(raw, null, raw.sourceCollection || "regularSlots");
    const teacher = teachersById.get(String(assignment.teacherId || ""));
    if (!teacher) return;
    const collectionName = assignment.sourceCollection === "overrideSlots" ? "overrideSlots" : "regularSlots";
    teacher[collectionName] ||= [];
    const teacherSlot = {
      ...assignment,
      id: assignment.sourceSlotId || assignment.id || assignment.assignmentId,
      normalizedRecurringAssignmentId: assignment.assignmentId,
      day: assignment.day || assignment.weekday || "",
      time: timeOnly(assignment.time),
      teacherId: assignment.teacherId || teacher.id
    };
    const teacherIndex = teacher[collectionName].findIndex(slot =>
      String(slot.normalizedRecurringAssignmentId || slot.assignmentId || slot.id || "") === String(assignment.assignmentId) ||
      (assignment.sourceSlotId && String(slot.id || "") === String(assignment.sourceSlotId))
    );
    if (teacherIndex >= 0) teacher[collectionName][teacherIndex] = { ...teacher[collectionName][teacherIndex], ...teacherSlot };
    else teacher[collectionName].push(teacherSlot);

    if (assignment.studentId) {
      const student = studentsById.get(String(assignment.studentId || ""));
      if (student) {
        student.regularSlots ||= [];
        const studentSlotId = assignment.studentSlotId || `student_slot_${assignment.assignmentId}`;
        const studentSlot = {
          id: studentSlotId,
          normalizedRecurringAssignmentId: assignment.assignmentId,
          teacherId: assignment.teacherId,
          day: assignment.day || assignment.weekday || "",
          time: timeOnly(assignment.time),
          subject: assignment.subject || "",
          startDate: assignment.startDate || "",
          endDate: assignment.endDate || "",
          source: assignment.source || assignment.sourceCollection || "recurring_assignments_v2",
          recordVersion: Number(assignment.recordVersion || 1),
          createdAt: assignment.createdAt || "",
          updatedAt: assignment.updatedAt || ""
        };
        const studentIndex = student.regularSlots.findIndex(slot =>
          String(slot.normalizedRecurringAssignmentId || "") === String(assignment.assignmentId) ||
          String(slot.id || "") === String(studentSlotId)
        );
        if (studentIndex >= 0) student.regularSlots[studentIndex] = { ...student.regularSlots[studentIndex], ...studentSlot };
        else student.regularSlots.push(studentSlot);
      }
    }
  });
  data.recurringAssignments = mergeById(data.recurringAssignments, assignments, "assignmentId");
  return data;
}

async function loadComposedState(key = "production", options = {}) {
  const legacy = await loadLegacyState(key);
  if (options.backfill === true) {
    await backfillBookingsFromAppState(key);
    await backfillRecurringAssignmentsFromAppState(key);
  }
  const normalized = await normalizedRows(key);
  const data = legacy.data ? { ...legacy.data } : null;
  if (!data) return { ...legacy, data, version: Math.max(legacy.version, normalized.systemVersion), normalized };
  data.bookings = mergeById(data.bookings, normalized.bookings, "id");
  overlayRecurringAssignments(data, normalized.recurringAssignments);
  data.replacements = mergeById(data.replacements, normalized.replacements, "id");
  data.replacementCredits = mergeById(data.replacementCredits, normalized.replacementCredits, "id");
  data.activityLogs = mergeById(data.activityLogs, normalized.activityLogs, "id")
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 2500);
  const version = Math.max(Number(legacy.version || 0), Number(normalized.systemVersion || 0));
  return {
    ...legacy,
    data,
    version,
    updatedAt: normalized.systemUpdatedAt || legacy.updatedAt,
    normalized
  };
}

module.exports = {
  backfillBookingsFromAppState,
  backfillRecurringAssignmentsFromAppState,
  bookingBackfillStatus,
  dateOnly,
  loadComposedState,
  loadLegacyState,
  normalizeRecurringAssignment,
  normalizedRows,
  recurringAssignmentBackfillStatus,
  stateKey,
  timeOnly
};
