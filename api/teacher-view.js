const { getSql, ensureCoreTables } = require("../lib/db");
const { setCors, sendJson, handleOptions, safeError } = require("../lib/http");
const {
  bookingAmendmentTime,
  isDeletedBooking,
  resolveBookingRecords
} = require("../lib/booking-resolution");
const calendarResolver = require("../lib/calendar-resolver");

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const API_BUILD = "2026.07.15-micro-franchise-package-lookup.1";

function stateKey(req) {
  return String((req.query && req.query.key) || "production").trim() || "production";
}

function cleanTeacherName(value) {
  return String(value || "").replace(/^\d{4}\s+/, "").replace(/\s+/g, " ").trim();
}

function cleanStudentName(value) {
  return String(value || "").replace(/\s*\((?:BC|CN|BM|PK|SOK|PHONICS|CREATIVE MATHS)\)\s*$/ig, "").replace(/\s+/g, " ").trim();
}

function slug(value) {
  return cleanTeacherName(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function dateOnly(value) {
  return String(value || "").split("T")[0].split(" ")[0];
}

function rawTimePart(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.includes("T")) {
    const match = text.match(/T(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (match) return `${match[1].padStart(2, "0")}:${match[2]}:${match[3] || "00"}`;
  }
  const ampm = text.match(/\b(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(AM|PM)\b/i);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = Number(ampm[2] || 0);
    const second = Number(ampm[3] || 0);
    const suffix = ampm[4].toUpperCase();
    if (suffix === "PM" && hour !== 12) hour += 12;
    if (suffix === "AM" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  }
  const match = text.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (match) return `${match[1].padStart(2, "0")}:${match[2]}:${match[3] || "00"}`;
  return "";
}

function timeFromTotalMinutes(total) {
  let adjusted = Math.round(total / 30) * 30;
  if (adjusted < 0) adjusted = 0;
  if (adjusted >= 24 * 60) adjusted = (24 * 60) - 30;
  return `${String(Math.floor(adjusted / 60)).padStart(2, "0")}:${String(adjusted % 60).padStart(2, "0")}`;
}

function normalizeTime(value) {
  const text = String(value || "").trim();
  const sheetDateTime = text.match(/^1899-12-\d{2}T(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (sheetDateTime) {
    const total = (Number(sheetDateTime[1]) * 60) + Number(sheetDateTime[2]) + (Number(sheetDateTime[3] || 0) / 60) - (83 + (18 / 60));
    return timeFromTotalMinutes(total);
  }
  const part = rawTimePart(value);
  if (!part) return "";
  const [hour, minute, second] = part.split(":").map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return "";
  return timeFromTotalMinutes((hour * 60) + minute + (Number(second || 0) / 60));
}

function dateRangeMatches(value, from, to) {
  const date = dateOnly(value);
  return (!from || date >= from) && (!to || date <= to);
}

function parseISODate(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  return new Date(year || new Date().getFullYear(), (month || 1) - 1, day || 1);
}

function localISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateOffsetISO(value, days) {
  const date = parseISODate(value);
  date.setDate(date.getDate() + days);
  return localISO(date);
}

function dayName(dateISO) {
  const date = parseISODate(dateISO);
  return DAYS[(date.getDay() + 6) % 7];
}

function fixedSnapshotParts(booking) {
  if ((booking && booking.source) !== "fixed_regular_snapshot") return null;
  const match = String((booking && booking.id) || "").match(/^history_(teacher_.+?)_(\d{4}-\d{2}-\d{2})_(\d{2})_(\d{2})_/);
  if (!match) return null;
  return { teacherId: match[1], date: match[2], time: `${match[3]}:${match[4]}` };
}

function repairFixedSnapshotBooking(booking) {
  const parts = fixedSnapshotParts(booking);
  if (!parts) return booking;
  return {
    ...booking,
    teacherId: booking.teacherId || parts.teacherId,
    date: parts.date,
    day: dayName(parts.date),
    time: parts.time
  };
}

function normalizeBookingsForTeacherView(bookings) {
  const seenFixedSnapshotIds = new Set();
  return (Array.isArray(bookings) ? bookings : [])
    .map(booking => repairFixedSnapshotBooking(booking))
    .filter(booking => {
      if ((booking.source || "") !== "fixed_regular_snapshot" || !booking.id) return true;
      if (seenFixedSnapshotIds.has(booking.id)) return false;
      seenFixedSnapshotIds.add(booking.id);
      return true;
    });
}

function datesBetween(from, to) {
  const rows = [];
  if (!from || !to) return rows;
  for (let date = from; date <= to; date = dateOffsetISO(date, 1)) rows.push(date);
  return rows;
}

function findStudent(state, studentId, studentName) {
  const cleanName = cleanStudentName(studentName).toLowerCase();
  const students = Array.isArray(state.students) ? state.students : [];
  return students.find(student => studentId && String(student.id || "") === String(studentId))
    || students.find(student => cleanName && cleanStudentName(student.name).toLowerCase() === cleanName)
    || null;
}

function findStudentById(state, studentId) {
  if (!studentId) return null;
  return (Array.isArray(state.students) ? state.students : []).find(student => String(student.id || "") === String(studentId)) || null;
}

function isStudentArchived(student) {
  return !student || student.status === "archived" || student.archived === true || student.deleted === true;
}

function studentNoteId(teacherId, studentId, studentName) {
  const key = studentId || cleanStudentName(studentName).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `teacher_student_${teacherId}_${key || "student"}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function teacherStudentNotes(state) {
  state.teacherStudentNotes = Array.isArray(state.teacherStudentNotes) ? state.teacherStudentNotes : [];
  return state.teacherStudentNotes;
}

function noteForStudent(state, teacherId, studentId, studentName) {
  const cleanName = cleanStudentName(studentName).toLowerCase();
  return teacherStudentNotes(state).find(note =>
    note.teacherId === teacherId &&
    ((studentId && note.studentId === studentId) || (!studentId && cleanStudentName(note.studentName).toLowerCase() === cleanName))
  ) || null;
}

function activeTeacherStudents(teacher, state) {
  const rows = new Map();
  const add = (studentId, studentName, subject = "") => {
    const cleanName = cleanStudentName(studentName);
    if (!cleanName) return;
    const student = findStudent(state, studentId, cleanName);
    if (!student || isStudentArchived(student)) return;
    const resolvedId = student?.id || studentId || "";
    const resolvedName = cleanStudentName(student?.name || cleanName);
    const key = resolvedId || resolvedName.toLowerCase();
    if (!key) return;
    const existing = rows.get(key) || { studentId: resolvedId, studentName: resolvedName, subjects: new Set() };
    if (subject) existing.subjects.add(subject);
    rows.set(key, existing);
  };

  (teacher.regularSlots || []).forEach(slot => {
    if (slot.locked && !slot.reserved && slot.studentName) add("", slot.studentName, slot.subject || "");
  });
  (state.students || [])
    .filter(student => !isStudentArchived(student))
    .forEach(student => {
      const slots = Array.isArray(student.regularSlots)
        ? student.regularSlots
        : (student.day || student.time || student.teacherId ? [{ teacherId: student.teacherId || "", day: student.day || "", time: student.time || "", subject: student.subject || "" }] : []);
      slots
        .filter(slot => slot.teacherId === teacher.id)
        .forEach(slot => add(student.id || "", student.name || "", slot.subject || student.subject || ""));
    });

  return [...rows.values()]
    .map((row, index) => {
      const note = noteForStudent(state, teacher.id, row.studentId, row.studentName);
      return {
        no: index + 1,
        id: note?.id || studentNoteId(teacher.id, row.studentId, row.studentName),
        teacherId: teacher.id,
        studentId: row.studentId || "",
        studentName: row.studentName,
        subjects: [...row.subjects].filter(Boolean),
        currentLevel: note?.currentLevel || "",
        remark: note?.remark || "",
        archived: false,
        lastUpdatedAt: note?.lastUpdatedAt || "",
        lastUpdatedBy: note?.lastUpdatedBy || ""
      };
    })
    .sort((a, b) => a.studentName.localeCompare(b.studentName, "en", { sensitivity: "base" }))
    .map((row, index) => ({ ...row, no: index + 1 }));
}

function lessonPay(teacher, state, studentId, studentName) {
  if ((teacher.category || "freelance") === "micro_franchisee") {
    const student = findStudentById(state, studentId);
    const amount = Number(student?.packageAmount || 0);
    const classes = Number(student?.packageClasses || 0);
    const share = Number(teacher.profitShare || 0) / 100;
    return amount && classes && share ? (amount / classes) * share : 0;
  }
  return Number(teacher.rate || 0);
}

function activePolicyRule(state, date = "") {
  return [...(state.policyRules || [])]
    .filter(rule => rule.status !== "archived" && (!date || !rule.effectiveFrom || rule.effectiveFrom <= date))
    .sort((a, b) => String(b.effectiveFrom || "").localeCompare(String(a.effectiveFrom || "")) || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0] || {
      notShowAllowance: 5
    };
}

function notShowAllowance(state, date = "") {
  return Number(activePolicyRule(state, date).notShowAllowance ?? 5);
}

function studentPackageClassCount(student) {
  const value = student?.packageClasses ?? student?.packageTotalClasses ?? student?.totalClasses ?? student?.packageTotalClass;
  return Number(value);
}

function getTeacherIncomeMode(teacher) {
  return (teacher?.category || "freelance") === "micro_franchisee" ? "profit_share" : "fixed_rate";
}

function teacherCategoryLabel(teacher) {
  return getTeacherIncomeMode(teacher) === "profit_share" ? "Micro Franchisee" : "Freelance Tutor";
}

function slotDateTime(dateISO, time) {
  const [year, month, day] = String(dateISO || "").split("-").map(Number);
  const [hour, minute] = normalizeTime(time).split(":").map(Number);
  return new Date(year || 1970, (month || 1) - 1, day || 1, hour || 0, minute || 0);
}

function slotHasPassed(dateISO, time, reference = new Date()) {
  const dt = slotDateTime(dateISO, time);
  return !Number.isNaN(dt.getTime()) && dt < reference;
}

function incomeStatusForCell(cell, reference = new Date()) {
  const status = cell?.status || "booked";
  return status === "booked" && slotHasPassed(cell.date, cell.time, reference) ? "completed" : status;
}

function isPaidCompletedCell(cell, reference = new Date()) {
  const type = String(cell?.type || "").toLowerCase();
  const status = cell?.status || "";
  return status === "completed" && type !== "practical class" && type !== "cancelled";
}

function isNoShowCell(cell) {
  return (cell?.status || "") === "student_not_show";
}

function packageValidation(student, teacher, lookupDiagnostic = "") {
  if (!student) {
    return {
      valid: false,
      reasons: [lookupDiagnostic || "Student profile not found"],
      packageName: "",
      packageAmount: 0,
      packageTotalClasses: 0,
      profitSharePercentage: Number(teacher?.profitShare || 0)
    };
  }
  const packageAmount = Number(student?.packageAmount);
  const packageTotalClasses = studentPackageClassCount(student);
  const profitSharePercentage = Number(teacher?.profitShare);
  const reasons = [];
  if (!Number.isFinite(packageAmount) || packageAmount <= 0) reasons.push("Package amount missing in Student Profile");
  if (!Number.isFinite(packageTotalClasses)) reasons.push("Package total classes missing in Student Profile");
  else if (packageTotalClasses <= 0) reasons.push("Package total classes must be greater than 0");
  if (!Number.isFinite(profitSharePercentage) || profitSharePercentage < 0 || profitSharePercentage > 100) reasons.push("profit share invalid");
  return {
    valid: reasons.length === 0,
    reasons,
    packageName: student?.package || "",
    packageAmount: Number.isFinite(packageAmount) ? packageAmount : 0,
    packageTotalClasses: Number.isFinite(packageTotalClasses) ? packageTotalClasses : 0,
    profitSharePercentage: Number.isFinite(profitSharePercentage) ? profitSharePercentage : 0
  };
}

function calculateFreelanceTeacherIncome({ teacher, completedCells, noShowCells, state }) {
  const approvedClassRate = Number(teacher?.rate || 0);
  const completedIncome = completedCells.reduce((sum, cell) => sum + Number(cell.estimatedPay || approvedClassRate || 0), 0);
  const noShowAllowanceTotal = noShowCells.reduce((sum, cell) => sum + Number(cell.estimatedPay || notShowAllowance(state, cell.date) || 0), 0);
  return {
    teacherCategory: teacherCategoryLabel(teacher),
    incomeMode: "fixed_rate",
    approvedClassRate,
    completedLessons: completedCells.length,
    completedIncome,
    noShowAllowance: noShowAllowanceTotal,
    totalIncome: completedIncome + noShowAllowanceTotal
  };
}

function calculateMicroFranchiseStudentIncome({ teacher, student, studentId, studentName, completedCells, lookupDiagnostic }) {
  const validation = packageValidation(student, teacher, lookupDiagnostic);
  const lessonRate = validation.valid ? validation.packageAmount / validation.packageTotalClasses : 0;
  const teacherRatePerLesson = validation.valid ? lessonRate * (validation.profitSharePercentage / 100) : 0;
  const income = validation.valid ? completedCells.length * teacherRatePerLesson : 0;
  return {
    studentId: student?.id || studentId || "",
    studentName: cleanStudentName(student?.name || studentName || "Student"),
    packageName: validation.packageName,
    packageAmount: validation.packageAmount,
    packageTotalClasses: validation.packageTotalClasses,
    lessonRate,
    profitSharePercentage: validation.profitSharePercentage,
    teacherRatePerLesson,
    completedLessons: completedCells.length,
    income,
    packageIncomplete: !validation.valid,
    diagnostic: validation.valid ? "" : `Package incomplete: ${cleanStudentName(student?.name || studentName || "Unknown student")} (${validation.reasons[0] || "Student Profile package incomplete"})`
  };
}

function studentProfileForIncomeCell(state, cell) {
  const byId = findStudentById(state, cell?.studentId);
  if (byId) return { student: byId, diagnostic: "" };
  const students = Array.isArray(state.students) ? state.students : [];
  const cellDay = cell?.day || dayName(dateOnly(cell?.date));
  const cellTime = normalizeTime(cell?.time);
  const cellDate = dateOnly(cell?.date);
  const cellName = cleanStudentName(cell?.studentName || "").toLowerCase();
  const legacyMatch = students.find(student => {
    const slots = Array.isArray(student.regularSlots) ? student.regularSlots : [];
    if (cellName && cleanStudentName(student.name || "").toLowerCase() !== cellName) return false;
    return slots.some(slot =>
      String(slot.teacherId || "") === String(cell?.teacherId || "") &&
      normalizeTime(slot.time) === cellTime &&
      String(slot.day || "") === String(cellDay || "") &&
      (!slot.startDate || dateOnly(slot.startDate) <= cellDate) &&
      (!slot.endDate || dateOnly(slot.endDate) >= cellDate)
    );
  });
  if (legacyMatch) return { student: legacyMatch, diagnostic: "Matched legacy timetable cell to Student Profile regular slot." };
  return {
    student: null,
    diagnostic: cell?.studentId
      ? `Student profile not found for studentId: ${cell.studentId}`
      : "Student profile not found for this completed lesson."
  };
}

function calculateMicroFranchiseTeacherIncome({ teacher, completedCells, noShowCells, state }) {
  const byStudent = new Map();
  completedCells.forEach(cell => {
    const lookup = studentProfileForIncomeCell(state, cell);
    const student = lookup.student;
    const key = student?.id || cell.studentId || `missing_${cell.studentName || "student"}`;
    const row = byStudent.get(key) || { studentId: student?.id || cell.studentId || "", studentName: student?.name || cell.studentName || "", student, lookupDiagnostic: lookup.diagnostic, cells: [] };
    if (student && !row.student) row.student = student;
    if (lookup.diagnostic && !row.lookupDiagnostic) row.lookupDiagnostic = lookup.diagnostic;
    row.cells.push(cell);
    byStudent.set(key, row);
  });
  const studentIncomeRows = [...byStudent.values()]
    .map(row => calculateMicroFranchiseStudentIncome({
      teacher,
      student: row.student || findStudentById(state, row.studentId),
      studentId: row.studentId,
      studentName: row.studentName,
      completedCells: row.cells,
      lookupDiagnostic: row.lookupDiagnostic
    }))
    .sort((a, b) => a.studentName.localeCompare(b.studentName, "en", { sensitivity: "base" }));
  const completedIncome = studentIncomeRows.reduce((sum, row) => sum + (row.packageIncomplete ? 0 : Number(row.income || 0)), 0);
  const noShowAllowanceTotal = noShowCells.reduce((sum, cell) => sum + Number(cell.estimatedPay || notShowAllowance(state, cell.date) || 0), 0);
  return {
    teacherCategory: teacherCategoryLabel(teacher),
    incomeMode: "profit_share",
    profitSharePercentage: Number(teacher?.profitShare || 0),
    completedLessons: completedCells.length,
    studentIncomeRows,
    packageWarnings: studentIncomeRows.filter(row => row.packageIncomplete).map(row => row.diagnostic),
    completedIncome,
    noShowAllowance: noShowAllowanceTotal,
    totalIncome: completedIncome + noShowAllowanceTotal
  };
}

function calculateTeacherMonthlyIncome({ teacher, state, cells, month, year }) {
  const reference = new Date();
  const targetMonth = Number(month);
  const targetYear = Number(year);
  const monthCells = (Array.isArray(cells) ? cells : [])
    .filter(cell => dateOnly(cell.date))
    .filter(cell => {
      const date = parseISODate(dateOnly(cell.date));
      return date.getMonth() === targetMonth && date.getFullYear() === targetYear;
    })
    .filter(cell => !["open", "reserved", "off"].includes(cell.kind) && cell.status !== "off" && !cell.unavailable);
  const completedCells = monthCells.filter(cell => isPaidCompletedCell(cell, reference));
  const noShowCells = monthCells.filter(isNoShowCell);
  const cancelledCells = monthCells.filter(cell => ["cancelled", "public_holiday", "teacher_leave"].includes(cell.status || ""));
  const base = getTeacherIncomeMode(teacher) === "profit_share"
    ? calculateMicroFranchiseTeacherIncome({ teacher, completedCells, noShowCells, state })
    : calculateFreelanceTeacherIncome({ teacher, completedCells, noShowCells, state });
  return {
    ...base,
    month: targetMonth,
    year: targetYear,
    noShowCount: noShowCells.length,
    cancelledCount: cancelledCells.length,
    currency: "MYR",
    calculatedAt: new Date().toISOString()
  };
}

function slotRank(slot) {
  if (slot.unavailable) return 5;
  if (slot.locked && slot.studentName) return 4;
  if (slot.locked) return 3;
  if (slot.source === "override") return 2;
  return 1;
}

function uniqueSlots(slots) {
  const byTime = new Map();
  slots.forEach(slot => {
    const time = normalizeTime(slot.time);
    if (!time) return;
    const normalized = { ...slot, time };
    const key = `${normalized.date || ""}|${normalized.time}`;
    const existing = byTime.get(key);
    if (!existing || slotRank(normalized) > slotRank(existing)) byTime.set(key, normalized);
  });
  return [...byTime.values()];
}

function bookingSlotKey(booking) {
  const time = normalizeTime(booking && booking.time);
  const date = dateOnly(booking && booking.date);
  if (!booking || !booking.teacherId || !date || !time) return "";
  return `${booking.teacherId}|${date}|${time}`;
}

function uniqueBookings(bookings) {
  const normalized = (Array.isArray(bookings) ? bookings : [])
    .map(booking => ({ ...booking, time: normalizeTime(booking.time), date: dateOnly(booking.date) }))
    .filter(booking => bookingSlotKey(booking));
  return [...resolveBookingRecords(normalized, bookingSlotKey).winners.values()];
}

function bookingDebugRecord(booking, selected = false, reason = "") {
  return {
    sourceRecordId: booking.id || "",
    teacherId: booking.teacherId || "",
    studentId: booking.studentId || "",
    bookingId: booking.id || "",
    studentName: booking.studentName || "",
    status: booking.status || "booked",
    classType: booking.type || "regular class",
    createdAt: booking.createdAt || booking.created_at || "",
    updatedAt: booking.updatedAt || booking.updated_at || "",
    slotRevisionAt: booking.slotRevisionAt || "",
    statusChangedAt: booking.statusChangedAt || "",
    amendmentTime: bookingAmendmentTime(booking),
    loadedFrom: "neon.app_state.bookings",
    selectedWinner: selected,
    reason
  };
}

function debugTeacherViewBookingChoice(teacher, dateISO, time, trace, winner) {
  if (!trace || trace.length < 2) return;
  console.info("[teacher-view canonical booking]", {
    teacherId: teacher.id,
    teacherName: teacher.name,
    date: dateISO,
    time: normalizeTime(time),
    records: trace.map(item => bookingDebugRecord(item.booking, item.booking === winner, item.reason)),
    selectedWinner: winner ? bookingDebugRecord(winner, true, "canonical winner") : null
  });
}

function bookingResolutionDiagnostics(bookings) {
  const normalized = (Array.isArray(bookings) ? bookings : [])
    .map(booking => ({ ...booking, date: dateOnly(booking.date), time: normalizeTime(booking.time) }))
    .filter(booking => bookingSlotKey(booking));
  const resolution = resolveBookingRecords(normalized, bookingSlotKey);
  return [...resolution.traces.entries()]
    .filter(([, trace]) => trace.length > 1 || trace.some(item => !item.selected))
    .map(([slotKey, trace]) => {
      const winner = resolution.winners.get(slotKey);
      return {
        slotKey,
        records: trace.map(item => bookingDebugRecord(item.booking, item.booking === winner, item.reason)),
        selectedWinner: winner ? bookingDebugRecord(winner, true, "canonical winner") : null
      };
    });
}

function slotAppliesOnDate(slot, dateISO, day) {
  if (slot.date) return dateOnly(slot.date) === dateISO;
  return slot.day === day &&
    (!slot.startDate || dateOnly(slot.startDate) <= dateISO) &&
    (!slot.endDate || dateOnly(slot.endDate) >= dateISO);
}

function teacherDateTimeKey(teacherId, dateISO, time) {
  return `${teacherId || ""}|${dateOnly(dateISO)}|${normalizeTime(time) || time || ""}`;
}

function latestOverridesForDate(teacher, dateISO, day) {
  const byCell = new Map();
  (teacher.overrideSlots || [])
    .filter(slot => slotAppliesOnDate(slot, dateISO, day))
    .map(slot => ({ ...slot, time: normalizeTime(slot.time) }))
    .filter(slot => slot.time)
    .forEach(slot => {
      const key = teacherDateTimeKey(teacher.id, dateISO, slot.time);
      slot._cellKey = key;
      const existing = byCell.get(key);
      if (!existing || bookingAmendmentTime(slot) >= bookingAmendmentTime(existing)) byCell.set(key, slot);
    });
  return byCell;
}

function overrideSupersedesRegularSlot(override, regularSlot) {
  if (!override) return false;
  if (!regularSlot) return true;
  const overrideTime = bookingAmendmentTime(override);
  const regularTime = bookingAmendmentTime(regularSlot);
  if (regularSlot.locked && !override.locked && !override.unavailable && !override.studentName) return false;
  return overrideTime >= regularTime;
}

function collectTeacherSlotsForDate(teacher, dateISO) {
  const day = dayName(dateISO);
  const latestOverrides = latestOverridesForDate(teacher, dateISO, day);
  const keptRegularKeys = new Set();
  const regular = (teacher.regularSlots || [])
    .filter(slot => slot.day === day)
    .filter(slot => (!slot.startDate || dateOnly(slot.startDate) <= dateISO) && (!slot.endDate || dateOnly(slot.endDate) >= dateISO))
    .map(slot => ({ ...slot, date: dateISO, source: slot.source || "regular", time: normalizeTime(slot.time) }))
    .filter(slot => {
      const key = teacherDateTimeKey(teacher.id, dateISO, slot.time);
      const keep = !overrideSupersedesRegularSlot(latestOverrides.get(key), slot);
      if (keep) keptRegularKeys.add(key);
      return keep;
    });
  const overrides = [...latestOverrides.values()]
    .filter(slot => !keptRegularKeys.has(slot._cellKey || teacherDateTimeKey(teacher.id, dateISO, slot.time)))
    .map(slot => ({ ...slot, date: dateISO, day, source: "override", time: normalizeTime(slot.time) }));
  return uniqueSlots([...regular, ...overrides]);
}

function publicCellFromBooking(booking, teacher, state) {
  const status = booking.status || "booked";
  const date = dateOnly(booking.date);
  const time = normalizeTime(booking.time);
  return {
    cellKey: `${booking.teacherId || teacher.id}|${date}|${time}`,
    kind: "booking",
    id: booking.id,
    bookingId: booking.id,
    sourceRecordId: booking.id,
    teacherId: booking.teacherId || teacher.id,
    teacherName: teacher.name || "",
    slotId: booking.sourceSlotId || "",
    studentId: booking.studentId || "",
    loadedFrom: "neon.app_state.bookings",
    date,
    day: booking.day || dayName(date),
    time,
    studentName: cleanStudentName(booking.studentName || ""),
    subject: booking.subject || "",
    type: booking.type || "regular class",
    status,
    minutes: Number(booking.minutes || 25),
    remark: booking.remark || "",
    locked: true,
    available: false,
    source: booking.source || "booking",
    updatedAt: booking.updatedAt || booking.updated_at || "",
    slotRevisionAt: booking.slotRevisionAt || "",
    statusChangedAt: booking.statusChangedAt || "",
    changedAt: booking.changedAt || "",
    changedSlot: booking.changedSlot || null,
    rebookedAt: booking.rebookedAt || "",
    cancelledAt: booking.cancelledAt || "",
    completedAt: booking.completedAt || "",
    studentNotShowAt: booking.studentNotShowAt || "",
    createdAt: booking.createdAt || booking.created_at || "",
    resolvedAt: new Date().toISOString(),
    estimatedPay: status === "student_not_show" ? notShowAllowance(state, dateOnly(booking.date)) : lessonPay(teacher, state, booking.studentId || "", booking.studentName || "")
  };
}

function publicCellFromSlot(slot, teacher, state) {
  if (slot.reserved) {
    const date = dateOnly(slot.date);
    const time = normalizeTime(slot.time);
    return {
      cellKey: `${teacher.id}|${date}|${time}`,
      kind: "reserved",
      id: slot.id || "",
      bookingId: "",
      slotId: slot.id || "",
      sourceRecordId: slot.id || "",
      teacherId: teacher.id,
      teacherName: teacher.name || "",
      date,
      day: slot.day || dayName(date),
      time,
      studentId: slot.studentId || "",
      studentName: cleanStudentName(slot.reservationName || slot.studentName || ""),
      subject: slot.subject || "",
      type: "reserve",
      status: "reserved",
      locked: true,
      available: false,
      source: slot.source || "teacher-overview-reservation",
      sourceRecordId: slot.id || "",
      remark: slot.remark || "",
      minutes: 25,
      resolvedAt: new Date().toISOString(),
      estimatedPay: 0
    };
  }
  const date = dateOnly(slot.date);
  const time = normalizeTime(slot.time);
  return {
    cellKey: `${teacher.id}|${date}|${time}`,
    kind: slot.unavailable ? "off" : (slot.locked ? "fixed" : "open"),
    id: slot.id || "",
    bookingId: "",
    slotId: slot.id || "",
    sourceRecordId: slot.id || "",
    teacherId: teacher.id,
    teacherName: teacher.name,
    date,
    day: slot.day || dayName(date),
    time,
    studentId: slot.studentId || "",
    studentName: cleanStudentName(slot.studentName || ""),
    subject: slot.subject || "",
    type: slot.unavailable ? "off" : (slot.locked ? "regular class" : "open slot"),
    status: slot.unavailable ? "off" : (slot.locked ? "booked" : "available"),
    locked: Boolean(slot.locked),
    unavailable: Boolean(slot.unavailable),
    available: !slot.locked && !slot.unavailable,
    minutes: 25,
    source: slot.source || "",
    remark: slot.remark || "",
    createdAt: slot.createdAt || "",
    updatedAt: slot.updatedAt || slot.slotRevisionAt || "",
    resolvedAt: new Date().toISOString(),
    estimatedPay: slot.locked ? lessonPay(teacher, state, slot.studentId || "", slot.studentName || "") : 0
  };
}

function resolveTeacherCalendar(state, options = {}) {
  const teacher = options.teacher || findTeacher(state, { query: { teacherId: options.teacherId } });
  const from = dateOnly(options.from);
  const to = dateOnly(options.to);
  if (!teacher || !from || !to) {
    return { teacherId: options.teacherId || "", from, to, generatedAt: new Date().toISOString(), stateVersion: Number(options.stateVersion || 0), cells: [] };
  }
  const rawBookings = normalizeBookingsForTeacherView(state.bookings)
    .filter(booking => booking.teacherId === teacher.id)
    .filter(booking => dateRangeMatches(booking.date, from, to));
  const normalizedBookings = rawBookings
    .map(booking => ({ ...booking, date: dateOnly(booking.date), time: normalizeTime(booking.time) }))
    .filter(booking => bookingSlotKey(booking));
  const resolution = resolveBookingRecords(normalizedBookings, bookingSlotKey);
  const rows = [];
  datesBetween(from, to).forEach(dateISO => {
    const slots = collectTeacherSlotsForDate(teacher, dateISO);
    const slotByTime = new Map(slots.map(slot => [normalizeTime(slot.time), slot]));
    const bookingByTime = new Map();
    resolution.winners.forEach((booking, key) => {
      if (dateOnly(booking.date) === dateISO) bookingByTime.set(normalizeTime(booking.time), { booking, key });
    });
    const times = new Set([...slotByTime.keys(), ...bookingByTime.keys()]);
    times.forEach(time => {
      const resolved = bookingByTime.get(time);
      const booking = resolved && resolved.booking;
      const slot = slotByTime.get(time);
      const trace = resolved ? resolution.traces.get(resolved.key) : [];
      if (slot && slot.unavailable && (!booking || bookingAmendmentTime(slot) >= bookingAmendmentTime(booking))) {
        rows.push(publicCellFromSlot(slot, teacher, state));
        return;
      }
      if (booking) {
        debugTeacherViewBookingChoice(teacher, dateISO, time, trace, booking);
        if (isDeletedBooking(booking)) {
          if (slot && (!slot.locked || slot.unavailable) && !slot.reserved) rows.push(publicCellFromSlot(slot, teacher, state));
          return;
        }
        rows.push(publicCellFromBooking(booking, teacher, state));
      } else if (slot) {
        rows.push(publicCellFromSlot(slot, teacher, state));
      }
    });
  });
  return {
    teacherId: teacher.id,
    from,
    to,
    generatedAt: new Date().toISOString(),
    stateVersion: Number(options.stateVersion || 0),
    cells: rows
      .filter(cell => cell.time)
      .sort((a, b) => `${a.date || ""} ${a.time || ""}`.localeCompare(`${b.date || ""} ${b.time || ""}`))
  };
}

function publicTeacher(teacher) {
  return {
    id: teacher.id,
    name: cleanTeacherName(teacher.name),
    subjects: Array.isArray(teacher.subjects) ? teacher.subjects : [],
    photo: teacher.photo || "",
    email: teacher.email || "",
    status: teacher.status || "active",
    category: teacher.category || "freelance",
    payoutMethod: teacherCategoryLabel(teacher),
    incomeMode: getTeacherIncomeMode(teacher),
    rate: Number(teacher.rate || 0),
    profitShare: Number(teacher.profitShare || 0)
  };
}

function publicSlot(slot, teacher, state) {
  return {
    id: slot.id || "",
    day: slot.day || "",
    date: dateOnly(slot.date || ""),
    time: normalizeTime(slot.time),
    subject: slot.subject || "",
    studentName: cleanStudentName(slot.studentName || ""),
    locked: Boolean(slot.locked),
    reserved: Boolean(slot.reserved),
    reservationName: cleanStudentName(slot.reservationName || ""),
    reservationExpiresAt: dateOnly(slot.reservationExpiresAt || slot.endDate || ""),
    unavailable: Boolean(slot.unavailable),
    source: slot.source || "",
    startDate: dateOnly(slot.startDate || ""),
    endDate: dateOnly(slot.endDate || ""),
    remark: slot.remark || "",
    estimatedPay: slot.reserved ? 0 : lessonPay(teacher, state, slot.studentId || "", slot.studentName || "")
  };
}

function publicBooking(booking, teacher, state) {
  const status = booking.status || "booked";
  return {
    id: booking.id,
    bookingId: booking.id,
    sourceRecordId: booking.id,
    teacherId: booking.teacherId || teacher.id,
    studentId: booking.studentId || "",
    loadedFrom: "neon.app_state.bookings",
    date: dateOnly(booking.date || ""),
    day: booking.day || "",
    time: normalizeTime(booking.time),
    studentName: cleanStudentName(booking.studentName || ""),
    subject: booking.subject || "",
    type: booking.type || "regular class",
    status,
    minutes: Number(booking.minutes || 25),
    remark: booking.remark || "",
    updatedAt: booking.updatedAt || booking.updated_at || "",
    slotRevisionAt: booking.slotRevisionAt || "",
    statusChangedAt: booking.statusChangedAt || "",
    changedAt: booking.changedAt || "",
    changedSlot: booking.changedSlot || null,
    rebookedAt: booking.rebookedAt || "",
    cancelledAt: booking.cancelledAt || "",
    completedAt: booking.completedAt || "",
    studentNotShowAt: booking.studentNotShowAt || "",
    createdAt: booking.createdAt || booking.created_at || "",
    estimatedPay: status === "student_not_show" ? notShowAllowance(state, dateOnly(booking.date)) : lessonPay(teacher, state, booking.studentId || "", booking.studentName || "")
  };
}

function findTeacher(state, req) {
  const rawTeacher = String((req.query && (req.query.teacherId || req.query.teacher)) || "").trim();
  if (!rawTeacher) return null;
  const teachers = Array.isArray(state.teachers) ? state.teachers : [];
  return teachers.find(teacher => teacher.id === rawTeacher)
    || teachers.find(teacher => slug(teacher.name) === slug(rawTeacher))
    || teachers.find(teacher => cleanTeacherName(teacher.name).toLowerCase() === cleanTeacherName(rawTeacher).toLowerCase())
    || null;
}

function hasAdminApiKey(req) {
  const configured = process.env.API_SECRET;
  const provided = req.headers["x-api-key"];
  return Boolean(configured && provided && provided === configured);
}

function hasTeacherToken(req, teacher) {
  const provided = String((req.query && req.query.token) || "").trim();
  const saved = String(teacher.viewToken || teacher.timetableToken || teacher.shareToken || "").trim();
  return Boolean(saved && provided && provided === saved);
}

async function loadState(req, from, to) {
  await ensureCoreTables();
  const sql = getSql();
  const key = stateKey(req);
  const rawTeacher = String((req.query && (req.query.teacherId || req.query.teacher)) || "").trim();
  const compactTeacher = slug(rawTeacher).replace(/-/g, "");
  const rows = await sql`
    with source as (
      select key, data, version, updated_at, updated_by
      from app_state
      where key = ${key}
      limit 1
    ), teacher_match as (
      select teacher.value as teacher
      from source
      cross join lateral jsonb_array_elements(coalesce(source.data->'teachers', '[]'::jsonb)) as teacher(value)
      where teacher.value->>'id' = ${rawTeacher}
         or lower(coalesce(teacher.value->>'name', '')) = lower(${rawTeacher})
         or regexp_replace(lower(coalesce(teacher.value->>'name', '')), '[^a-z0-9]+', '', 'g') = ${compactTeacher}
      order by case
        when teacher.value->>'id' = ${rawTeacher} then 0
        when lower(coalesce(teacher.value->>'name', '')) = lower(${rawTeacher}) then 1
        else 2
      end
      limit 1
    )
    select
      source.key,
      source.version,
      source.updated_at,
      source.updated_by,
      case
        when left(coalesce(teacher_match.teacher->>'photo', ''), 5) = 'data:' then teacher_match.teacher - 'photo'
        else teacher_match.teacher
      end as teacher,
      coalesce((
        select jsonb_agg(booking.value)
        from jsonb_array_elements(coalesce(source.data->'bookings', '[]'::jsonb)) as booking(value)
        where (booking.value->>'teacherId' = teacher_match.teacher->>'id'
          or (booking.value->>'source' = 'fixed_regular_snapshot' and booking.value->>'id' like ('history_' || (teacher_match.teacher->>'id') || '_%')))
          and coalesce(booking.value->>'status', '') <> 'deleted'
          and (
            booking.value->>'source' = 'fixed_regular_snapshot'
            or (${from} = '' or left(coalesce(booking.value->>'date', ''), 10) >= ${from})
          )
          and (
            booking.value->>'source' = 'fixed_regular_snapshot'
            or (${to} = '' or left(coalesce(booking.value->>'date', ''), 10) <= ${to})
          )
      ), '[]'::jsonb) as bookings,
      coalesce((
        select jsonb_agg(
          case when left(coalesce(student.value->>'photo', ''), 5) = 'data:' then student.value - 'photo' else student.value end
        )
        from jsonb_array_elements(coalesce(source.data->'students', '[]'::jsonb)) as student(value)
        where coalesce(student.value->>'status', '') <> 'archived'
          and lower(coalesce(student.value->>'archived', 'false')) not in ('true', '1', 'yes')
          and (
            exists (
              select 1
              from jsonb_array_elements(coalesce(student.value->'regularSlots', '[]'::jsonb)) as student_slot(value)
              where student_slot.value->>'teacherId' = teacher_match.teacher->>'id'
            )
            or exists (
              select 1
              from jsonb_array_elements(coalesce(teacher_match.teacher->'regularSlots', '[]'::jsonb)) as teacher_slot(value)
              where coalesce(teacher_slot.value->>'locked', 'false') = 'true'
                and lower(coalesce(teacher_slot.value->>'studentName', '')) = lower(coalesce(student.value->>'name', ''))
            )
            or exists (
              select 1
              from jsonb_array_elements(coalesce(source.data->'bookings', '[]'::jsonb)) as student_booking(value)
              where student_booking.value->>'teacherId' = teacher_match.teacher->>'id'
                and (
                  (coalesce(student_booking.value->>'studentId', '') <> '' and student_booking.value->>'studentId' = student.value->>'id')
                  or lower(coalesce(student_booking.value->>'studentName', '')) = lower(coalesce(student.value->>'name', ''))
                )
            )
          )
      ), '[]'::jsonb) as students,
      coalesce((
        select jsonb_agg(note.value)
        from jsonb_array_elements(coalesce(source.data->'teacherStudentNotes', '[]'::jsonb)) as note(value)
        where note.value->>'teacherId' = teacher_match.teacher->>'id'
      ), '[]'::jsonb) as teacher_student_notes
    from source
    left join teacher_match on true
  `;
  if (!rows.length) return null;
  const row = rows[0];
  return {
    key: row.key,
    version: row.version,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    data: row.teacher ? {
      teachers: [row.teacher],
      bookings: Array.isArray(row.bookings) ? row.bookings : [],
      students: Array.isArray(row.students) ? row.students : [],
      teacherStudentNotes: Array.isArray(row.teacher_student_notes) ? row.teacher_student_notes : []
    } : null
  };
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;

  try {
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    const from = dateOnly(req.query && req.query.from);
    const to = dateOnly(req.query && req.query.to);
    const row = await loadState(req, from, to);
    if (!row || !row.data) return sendJson(res, 404, { ok: false, error: "Timetable data is not ready yet." });

    const state = row.data || {};
    state.bookings = calendarResolver.normalizeBookingsForTeacherView(state.bookings);
    const teacher = findTeacher(state, req);
    if (!teacher) return sendJson(res, 404, { ok: false, error: "Teacher not found." });
    if (!hasAdminApiKey(req) && !hasTeacherToken(req, teacher)) {
      return sendJson(res, 401, { ok: false, error: "Teacher timetable link is invalid or not synced yet. Ask admin to generate the teacher timetable view link again and wait for Neon sync success before sharing it." });
    }

    const bookingCandidates = (Array.isArray(state.bookings) ? state.bookings : [])
      .filter(booking => booking.teacherId === teacher.id)
      .map(booking => repairFixedSnapshotBooking(booking))
      .filter(booking => dateRangeMatches(booking.date, from, to));
    const resolvedCalendar = calendarResolver.resolveTeacherCalendar(state, { teacher, teacherId: teacher.id, from, to, stateVersion: Number(row.version || 0) });
    const cells = resolvedCalendar.cells;
    const selectedMonth = Number.isFinite(Number(req.query && req.query.month))
      ? Number(req.query.month)
      : parseISODate(from).getMonth();
    const selectedYear = Number.isFinite(Number(req.query && req.query.year))
      ? Number(req.query.year)
      : parseISODate(from).getFullYear();
    const incomeSummary = calculateTeacherMonthlyIncome({ teacher, state, cells, month: selectedMonth, year: selectedYear });
    const bookings = cells
      .filter(cell => cell.kind === "booking" || cell.bookingId)
      .map(cell => ({
        id: cell.bookingId || cell.id || "",
        bookingId: cell.bookingId || "",
        sourceRecordId: cell.sourceRecordId || cell.bookingId || "",
        teacherId: cell.teacherId || teacher.id,
        studentId: cell.studentId || "",
        loadedFrom: "api/teacher-view resolvedCalendar.cells",
        date: dateOnly(cell.date || ""),
        day: cell.day || "",
        time: normalizeTime(cell.time),
        studentName: cleanStudentName(cell.studentName || ""),
        subject: cell.subject || "",
        type: cell.type || "regular class",
        status: cell.status || "booked",
        minutes: Number(cell.minutes || 25),
        remark: cell.remark || "",
        updatedAt: cell.updatedAt || "",
        slotRevisionAt: cell.slotRevisionAt || "",
        statusChangedAt: cell.statusChangedAt || "",
        changedAt: cell.changedAt || "",
        changedSlot: cell.changedSlot || null,
        rebookedAt: cell.rebookedAt || "",
        cancelledAt: cell.cancelledAt || "",
        completedAt: cell.completedAt || "",
        studentNotShowAt: cell.studentNotShowAt || "",
        createdAt: cell.createdAt || "",
        estimatedPay: Number(cell.estimatedPay || 0)
      }));
    const debug = String(req.query && req.query.debug || "") === "1";

    return sendJson(res, 200, {
      ok: true,
      build: API_BUILD,
      key: row.key,
      version: Number(row.version || 0),
      updatedAt: row.updated_at,
      serverTime: new Date().toISOString(),
      loadedFrom: "neon.app_state",
      bookingResolution: "canonical_resolved_calendar",
      resolvedCalendar,
      days: DAYS,
      from,
      to,
      teacher: publicTeacher(teacher),
      incomeSummary,
      regularSlots: (teacher.regularSlots || []).map(slot => publicSlot(slot, teacher, state)),
      overrideSlots: (teacher.overrideSlots || []).map(slot => publicSlot(slot, teacher, state)),
      bookings,
      cells,
      students: activeTeacherStudents(teacher, state),
      ...(debug ? { bookingResolutionDiagnostics: calendarResolver.bookingResolutionDiagnostics(bookingCandidates) } : {})
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
