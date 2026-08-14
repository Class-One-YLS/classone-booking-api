const { ensureCoreTables } = require("../lib/db");
const { loadComposedState } = require("../lib/composed-state");
const { setCors, sendJson, handleOptions, safeError } = require("../lib/http");

function stateKey(req) {
  return String((req.query && req.query.key) || "production").trim() || "production";
}

function compactName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function hasTeacherToken(req, teacher) {
  const provided = String((req.query && req.query.token) || "").trim();
  const saved = String(teacher.viewToken || teacher.timetableToken || teacher.shareToken || "").trim();
  return Boolean(saved && provided && provided === saved);
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;

  try {
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    await ensureCoreTables();
    const key = stateKey(req);
    const rawTeacher = String((req.query && (req.query.teacherId || req.query.teacher)) || "").trim();
    if (!rawTeacher) return sendJson(res, 400, { ok: false, error: "Teacher is required." });
    const compactTeacher = compactName(rawTeacher);
    const row = await loadComposedState(key, { backfill: false });
    const teachers = Array.isArray(row.data?.teachers) ? row.data.teachers : [];
    const teacher = teachers.find(item => item.id === rawTeacher)
      || teachers.find(item => String(item.name || "").toLowerCase() === rawTeacher.toLowerCase())
      || teachers.find(item => compactName(item.name) === compactTeacher);
    if (!teacher) return sendJson(res, 404, { ok: false, error: "Teacher timetable is not ready yet." });
    if (!hasTeacherToken(req, teacher || {})) return sendJson(res, 401, { ok: false, error: "Teacher timetable link is invalid or not synced yet." });
    return sendJson(res, 200, {
      ok: true,
      key: row.key,
      teacherId: teacher.id,
      version: Number(row.version || 0),
      updatedAt: row.updatedAt,
      composed: true,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
