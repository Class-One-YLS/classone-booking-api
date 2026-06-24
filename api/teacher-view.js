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

function dateRangeMatches(value, from, to) {
  const date = dateOnly(value);
  return (!from || date >= from) && (!to || date <= to);
}

function publicTeacher(teacher) {
  return {
    id: teacher.id,
    name: cleanTeacherName(teacher.name),
    subjects: Array.isArray(teacher.subjects) ? teacher.subjects : [],
    photo: teacher.photo || "",
    status: teacher.status || "active"
  };
}

function publicSlot(slot) {
  return {
    id: slot.id || "",
    day: slot.day || "",
    date: dateOnly(slot.date || ""),
    time: slot.time || "",
    subject: slot.subject || "",
    studentName: cleanStudentName(slot.studentName || ""),
    locked: Boolean(slot.locked),
    unavailable: Boolean(slot.unavailable),
    source: slot.source || "",
    startDate: dateOnly(slot.startDate || ""),
    endDate: dateOnly(slot.endDate || ""),
    remark: slot.remark || ""
  };
}

function publicBooking(booking) {
  return {
    id: booking.id,
    date: dateOnly(booking.date || ""),
    day: booking.day || "",
    time: booking.time || "",
    studentName: cleanStudentName(booking.studentName || ""),
    subject: booking.subject || "",
    type: booking.type || "regular class",
    status: booking.status || "booked",
    minutes: Number(booking.minutes || 25),
    remark: booking.remark || ""
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
    const teacher = findTeacher(state, req);
    if (!teacher) return sendJson(res, 404, { ok: false, error: "Teacher not found." });
    if (!hasAdminApiKey(req) && !hasTeacherToken(req, teacher)) {
      return sendJson(res, 401, { ok: false, error: "Invalid or missing teacher timetable link." });
    }

    const from = dateOnly(req.query && req.query.from);
    const to = dateOnly(req.query && req.query.to);
    const bookings = (Array.isArray(state.bookings) ? state.bookings : [])
      .filter(booking => booking.teacherId === teacher.id)
      .filter(booking => booking.status !== "deleted")
      .filter(booking => dateRangeMatches(booking.date, from, to))
      .map(publicBooking);

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
      regularSlots: (teacher.regularSlots || []).map(publicSlot),
      overrideSlots: (teacher.overrideSlots || []).map(publicSlot),
      bookings
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
