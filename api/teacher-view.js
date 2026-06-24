const { getSql, ensureCoreTables } = require("../lib/db");
const { setCors, sendJson, handleOptions, safeError } = require("../lib/http");

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

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
  return students.find(student => studentId && student.id === studentId)
    || students.find(student => cleanName && cleanStudentName(student.name).toLowerCase() === cleanName)
    || null;
}

function lessonPay(teacher, state, studentId, studentName) {
  if ((teacher.category || "freelance") === "micro_franchisee") {
    const student = findStudent(state, studentId, studentName);
    const amount = Number(student?.packageAmount || 0);
    const classes = Number(student?.packageClasses || 0);
    const share = Number(teacher.profitShare || 0) / 100;
    return amount && classes && share ? (amount / classes) * share : 0;
  }
  return Number(teacher.rate || 0);
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

function bookingRank(booking) {
  const status = booking.status || "booked";
  if (["cancelled", "public_holiday", "teacher_leave", "student_not_show"].includes(status)) return 5;
  if (status === "booked") return 4;
  if (status === "completed") return 3;
  return 1;
}

function uniqueBookings(bookings) {
  const byTime = new Map();
  bookings.forEach(booking => {
    const time = normalizeTime(booking.time);
    if (!time) return;
    const normalized = { ...booking, time };
    const key = `${dateOnly(normalized.date)}|${normalized.time}`;
    const existing = byTime.get(key);
    if (!existing || bookingRank(normalized) > bookingRank(existing)) byTime.set(key, normalized);
  });
  return [...byTime.values()];
}

function collectTeacherSlotsForDate(teacher, dateISO) {
  const day = dayName(dateISO);
  const offOverrides = (teacher.overrideSlots || [])
    .filter(slot => dateOnly(slot.date) === dateISO && slot.unavailable)
    .map(slot => ({ ...slot, time: normalizeTime(slot.time) }));
  const regular = (teacher.regularSlots || [])
    .filter(slot => slot.day === day)
    .filter(slot => (!slot.startDate || dateOnly(slot.startDate) <= dateISO) && (!slot.endDate || dateOnly(slot.endDate) >= dateISO))
    .filter(slot => !offOverrides.some(off => off.time && off.time === normalizeTime(slot.time)))
    .map(slot => ({ ...slot, date: dateISO, source: slot.source || "regular", time: normalizeTime(slot.time) }));
  const overrides = (teacher.overrideSlots || [])
    .filter(slot => dateOnly(slot.date) === dateISO && !slot.unavailable)
    .map(slot => ({ ...slot, date: dateISO, source: "override", time: normalizeTime(slot.time) }));
  return uniqueSlots([...regular, ...overrides]);
}

function publicCellFromBooking(booking, teacher, state) {
  const status = booking.status || "booked";
  return {
    kind: "booking",
    id: booking.id,
    date: dateOnly(booking.date),
    day: booking.day || dayName(dateOnly(booking.date)),
    time: normalizeTime(booking.time),
    studentName: cleanStudentName(booking.studentName || ""),
    subject: booking.subject || "",
    type: booking.type || "regular class",
    status,
    minutes: Number(booking.minutes || 25),
    remark: booking.remark || "",
    estimatedPay: status === "student_not_show" ? 5 : lessonPay(teacher, state, booking.studentId || "", booking.studentName || "")
  };
}

function publicCellFromSlot(slot, teacher, state) {
  return {
    kind: slot.locked ? "fixed" : "open",
    id: slot.id || "",
    date: dateOnly(slot.date),
    day: slot.day || dayName(dateOnly(slot.date)),
    time: normalizeTime(slot.time),
    studentName: cleanStudentName(slot.studentName || ""),
    subject: slot.subject || "",
    type: slot.locked ? "regular class" : "open slot",
    status: "booked",
    locked: Boolean(slot.locked),
    source: slot.source || "",
    remark: slot.remark || "",
    estimatedPay: slot.locked ? lessonPay(teacher, state, "", slot.studentName || "") : 0
  };
}

function timetableCells(teacher, state, from, to) {
  const allBookings = uniqueBookings(normalizeBookingsForTeacherView(state.bookings)
    .filter(booking => booking.teacherId === teacher.id)
    .filter(booking => booking.status !== "deleted")
    .filter(booking => dateRangeMatches(booking.date, from, to)));
  const rows = [];
  datesBetween(from, to).forEach(dateISO => {
    const slots = collectTeacherSlotsForDate(teacher, dateISO);
    const bookings = allBookings.filter(booking => dateOnly(booking.date) === dateISO);
    slots.forEach(slot => {
      const booking = bookings.find(item => normalizeTime(item.time) === normalizeTime(slot.time));
      rows.push(booking ? publicCellFromBooking(booking, teacher, state) : publicCellFromSlot(slot, teacher, state));
    });
  });
  return rows
    .filter(cell => cell.time)
    .sort((a, b) => `${a.date || ""} ${a.time || ""}`.localeCompare(`${b.date || ""} ${b.time || ""}`));
}

function publicTeacher(teacher) {
  return {
    id: teacher.id,
    name: cleanTeacherName(teacher.name),
    subjects: Array.isArray(teacher.subjects) ? teacher.subjects : [],
    photo: teacher.photo || "",
    status: teacher.status || "active",
    payoutMethod: (teacher.category || "freelance") === "micro_franchisee" ? "Micro Franchisee" : "Freelance Tutor",
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
    unavailable: Boolean(slot.unavailable),
    source: slot.source || "",
    startDate: dateOnly(slot.startDate || ""),
    endDate: dateOnly(slot.endDate || ""),
    remark: slot.remark || "",
    estimatedPay: lessonPay(teacher, state, "", slot.studentName || "")
  };
}

function publicBooking(booking, teacher, state) {
  const status = booking.status || "booked";
  return {
    id: booking.id,
    date: dateOnly(booking.date || ""),
    day: booking.day || "",
    time: normalizeTime(booking.time),
    studentName: cleanStudentName(booking.studentName || ""),
    subject: booking.subject || "",
    type: booking.type || "regular class",
    status,
    minutes: Number(booking.minutes || 25),
    remark: booking.remark || "",
    estimatedPay: status === "student_not_show" ? 5 : lessonPay(teacher, state, booking.studentId || "", booking.studentName || "")
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

async function loadState(req) {
  await ensureCoreTables();
  const sql = getSql();
  const key = stateKey(req);
  const rows = await sql`
    select key, data, version, updated_at, updated_by
    from app_state
    where key = ${key}
    limit 1
  `;
  if (!rows.length) return null;
  return rows[0];
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;

  try {
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    const row = await loadState(req);
    if (!row || !row.data) return sendJson(res, 404, { ok: false, error: "Timetable data is not ready yet." });

    const state = row.data || {};
    state.bookings = normalizeBookingsForTeacherView(state.bookings);
    const teacher = findTeacher(state, req);
    if (!teacher) return sendJson(res, 404, { ok: false, error: "Teacher not found." });
    if (!hasAdminApiKey(req) && !hasTeacherToken(req, teacher)) {
      return sendJson(res, 401, { ok: false, error: "Teacher timetable link is invalid or not synced yet. Ask admin to generate the teacher timetable view link again and wait for Neon sync success before sharing it." });
    }

    const from = dateOnly(req.query && req.query.from);
    const to = dateOnly(req.query && req.query.to);
    const bookings = (Array.isArray(state.bookings) ? state.bookings : [])
      .filter(booking => booking.teacherId === teacher.id)
      .filter(booking => booking.status !== "deleted")
      .filter(booking => dateRangeMatches(booking.date, from, to))
      .map(booking => publicBooking(booking, teacher, state));
    const cells = timetableCells(teacher, state, from, to);

    return sendJson(res, 200, {
      ok: true,
      key: row.key,
      version: Number(row.version || 0),
      updatedAt: row.updated_at,
      serverTime: new Date().toISOString(),
      days: DAYS,
      from,
      to,
      teacher: publicTeacher(teacher),
      regularSlots: (teacher.regularSlots || []).map(slot => publicSlot(slot, teacher, state)),
      overrideSlots: (teacher.overrideSlots || []).map(slot => publicSlot(slot, teacher, state)),
      bookings,
      cells
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
