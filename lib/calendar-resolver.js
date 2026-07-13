const {
  bookingAmendmentTime,
  isDeletedBooking,
  resolveBookingRecords
} = require("./booking-resolution");

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

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

function datesBetween(from, to) {
  const rows = [];
  if (!from || !to) return rows;
  for (let date = from; date <= to; date = dateOffsetISO(date, 1)) rows.push(date);
  return rows;
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

function findTeacher(state, options = {}) {
  const rawTeacher = String(options.teacherId || options.teacher || "").trim();
  if (!rawTeacher) return null;
  const teachers = Array.isArray(state.teachers) ? state.teachers : [];
  return teachers.find(teacher => teacher.id === rawTeacher)
    || teachers.find(teacher => slug(teacher.name) === slug(rawTeacher))
    || teachers.find(teacher => cleanTeacherName(teacher.name).toLowerCase() === cleanTeacherName(rawTeacher).toLowerCase())
    || null;
}

function findStudent(state, studentId, studentName) {
  const cleanName = cleanStudentName(studentName).toLowerCase();
  const students = Array.isArray(state.students) ? state.students : [];
  return students.find(student => studentId && student.id === studentId)
    || students.find(student => cleanName && cleanStudentName(student.name).toLowerCase() === cleanName)
    || null;
}

function lessonPay(teacher, state, studentId, studentName) {
  if ((teacher.category || "freelance") === "micro_franchisee") {
    const student = findStudent(state, studentId, studentName);
    const amount = Number(student && student.packageAmount || 0);
    const classes = Number(student && student.packageClasses || 0);
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

function teacherDateTimeKey(teacherId, dateISO, time) {
  return `${teacherId || ""}|${dateOnly(dateISO)}|${normalizeTime(time) || time || ""}`;
}

function slotAppliesOnDate(slot, dateISO, day) {
  if (slot.date) return dateOnly(slot.date) === dateISO;
  return slot.day === day &&
    (!slot.startDate || dateOnly(slot.startDate) <= dateISO) &&
    (!slot.endDate || dateOnly(slot.endDate) >= dateISO);
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
    supersededAt: booking.supersededAt || "",
    deletedAt: booking.deletedAt || "",
    createdAt: booking.createdAt || booking.created_at || "",
    resolvedAt: new Date().toISOString(),
    estimatedPay: status === "student_not_show" ? notShowAllowance(state, dateOnly(booking.date)) : lessonPay(teacher, state, booking.studentId || "", booking.studentName || "")
  };
}

function publicCellFromSlot(slot, teacher, state) {
  const date = dateOnly(slot.date);
  const time = normalizeTime(slot.time);
  if (slot.reserved) {
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
      remark: slot.remark || "",
      minutes: 25,
      resolvedAt: new Date().toISOString(),
      estimatedPay: 0
    };
  }
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
    estimatedPay: slot.locked ? lessonPay(teacher, state, "", slot.studentName || "") : 0
  };
}

function resolveTeacherCalendar(state, options = {}) {
  const teacher = options.teacher || findTeacher(state, { teacherId: options.teacherId, teacher: options.teacherName });
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
      if (slot && slot.unavailable && (!booking || bookingAmendmentTime(slot) >= bookingAmendmentTime(booking))) {
        rows.push(publicCellFromSlot(slot, teacher, state));
        return;
      }
      if (booking) {
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

module.exports = {
  DAYS,
  bookingResolutionDiagnostics,
  bookingSlotKey,
  cleanStudentName,
  cleanTeacherName,
  collectTeacherSlotsForDate,
  dateOnly,
  dayName,
  normalizeBookingsForTeacherView,
  normalizeTime,
  publicCellFromBooking,
  publicCellFromSlot,
  resolveTeacherCalendar,
  teacherDateTimeKey
};
