const { getSql, ensureCoreTables } = require("../lib/db");
const { setCors, sendJson, handleOptions, readJson, safeError } = require("../lib/http");

function stateKey(req, body) {
  return String((body && body.key) || (req.query && req.query.key) || "production").trim() || "production";
}

function cleanStudentName(value) {
  return String(value || "").replace(/\s*\((?:BC|CN|BM|PK|SOK|PHONICS|CREATIVE MATHS)\)\s*$/ig, "").replace(/\s+/g, " ").trim();
}

function studentNoteId(teacherId, studentId, studentName) {
  const key = studentId || cleanStudentName(studentName).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `teacher_student_${teacherId}_${key || "student"}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function findTeacher(state, teacherId) {
  return (Array.isArray(state.teachers) ? state.teachers : []).find(teacher => teacher.id === teacherId) || null;
}

function hasTeacherToken(token, teacher) {
  const saved = String(teacher.viewToken || teacher.timetableToken || teacher.shareToken || "").trim();
  return Boolean(saved && String(token || "").trim() === saved);
}

async function loadState(key) {
  await ensureCoreTables();
  const sql = getSql();
  const rows = await sql`
    select key, data, version
    from app_state
    where key = ${key}
    limit 1
  `;
  return rows[0] || null;
}

async function saveState(key, data, updatedBy) {
  const sql = getSql();
  const rows = await sql`
    update app_state
    set data = ${JSON.stringify(data)}::jsonb,
        version = app_state.version + 1,
        updated_at = now(),
        updated_by = ${updatedBy}
    where key = ${key}
    returning key, version, updated_at, updated_by
  `;
  if (!rows.length) throw new Error("State not found.");
  await sql`delete from app_state_text_chunks where state_key = ${key}`;
  await sql`
    insert into audit_logs (action, entity_type, entity_id, summary, after_data, created_by)
    values (
      'teacher_student_note_saved',
      'teacher_student_note',
      ${key},
      ${`Teacher student notes saved for ${updatedBy}`},
      ${JSON.stringify({ version: Number(rows[0].version || 0) })}::jsonb,
      ${updatedBy}
    )
  `;
  return rows[0];
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;

  try {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    const body = await readJson(req);
    const key = stateKey(req, body);
    const row = await loadState(key);
    if (!row || !row.data) return sendJson(res, 404, { ok: false, error: "Timetable data is not ready yet." });

    const state = row.data || {};
    const teacherId = String(body.teacherId || "").trim();
    const teacher = findTeacher(state, teacherId);
    if (!teacher) return sendJson(res, 404, { ok: false, error: "Teacher not found." });
    if (!hasTeacherToken(body.token, teacher)) return sendJson(res, 401, { ok: false, error: "Invalid teacher link token." });

    const records = Array.isArray(body.records) ? body.records : [];
    state.teacherStudentNotes = Array.isArray(state.teacherStudentNotes) ? state.teacherStudentNotes : [];
    const now = new Date().toISOString();
    records.forEach(record => {
      const studentId = String(record.studentId || "").trim();
      const studentName = cleanStudentName(record.studentName || "");
      if (!studentId && !studentName) return;
      const id = studentNoteId(teacherId, studentId, studentName);
      let note = state.teacherStudentNotes.find(item =>
        item.id === id ||
        (item.teacherId === teacherId && studentId && item.studentId === studentId) ||
        (item.teacherId === teacherId && !studentId && cleanStudentName(item.studentName).toLowerCase() === studentName.toLowerCase())
      );
      if (!note) {
        note = { id, teacherId, studentId, studentName, createdAt: now };
        state.teacherStudentNotes.push(note);
      }
      note.id = id;
      note.teacherId = teacherId;
      note.studentId = studentId;
      note.studentName = studentName || note.studentName || "";
      note.currentLevel = String(record.currentLevel || "").slice(0, 200);
      note.remark = String(record.remark || "").slice(0, 3000);
      note.archived = Boolean(record.archived);
      note.lastUpdatedAt = now;
      note.lastUpdatedBy = teacher.name || "Teacher";
    });

    const saved = await saveState(key, state, `Teacher: ${teacher.name || teacherId}`);
    return sendJson(res, 200, {
      ok: true,
      key: saved.key,
      version: Number(saved.version || 0),
      updatedAt: saved.updated_at,
      updatedBy: saved.updated_by || null
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
