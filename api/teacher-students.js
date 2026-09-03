const { getSql, getPool, ensureCoreTables } = require("../lib/db");
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

function findTeacher(teachers, teacherId) {
  return (Array.isArray(teachers) ? teachers : []).find(teacher => teacher.id === teacherId) || null;
}

function hasTeacherToken(token, teacher) {
  const saved = String(teacher.viewToken || teacher.timetableToken || teacher.shareToken || "").trim();
  return Boolean(saved && String(token || "").trim() === saved);
}

// Previously this endpoint called loadState()/saveState() which read the ENTIRE app_state.data blob
// (the whole legacy state -- tens of MB) just to look up one teacher for token validation, then wrote
// the WHOLE modified blob back on every single note save. For a state this size that read+rewrite is
// slow enough to trip Postgres/Neon connection termination ("Student note save failed: terminated",
// reported 2026-09-03), on top of being wasteful for something that only ever touches one small
// teacherStudentNotes record. This now does a lightweight read of just data->'teachers' for the token
// check, and writes the note directly into collection_records_v2 (the same normalized per-record
// table api/records/transaction.js already uses for this same "teacherStudentNotes" collection) --
// loadComposedState() merges that table back into data.teacherStudentNotes on every read, so this
// stays consistent with the admin app without ever touching the big legacy blob.
async function loadTeachersForTokenCheck(key) {
  await ensureCoreTables();
  const sql = getSql();
  const rows = await sql`select data -> 'teachers' as teachers from app_state where key = ${key} limit 1`;
  return Array.isArray(rows[0]?.teachers) ? rows[0].teachers : null;
}

function recordTime(record) {
  return Math.max(
    Date.parse(record?.lastUpdatedAt || "") || 0,
    Date.parse(record?.updatedAt || "") || 0,
    Date.parse(record?.createdAt || "") || 0
  );
}

async function upsertTeacherStudentNote(client, key, record) {
  const id = String(record.id || "").trim();
  if (!id) throw new Error("Note id is required.");
  const current = await client.query(
    "select data, record_version from collection_records_v2 where state_key = $1 and collection_name = $2 and record_id = $3 for update",
    [key, "teacherStudentNotes", id]
  );
  const existing = current.rows[0]?.data || null;
  if (existing && recordTime(existing) > recordTime(record)) return existing;
  const nextVersion = Number(current.rows[0]?.record_version || 0) + 1;
  const data = { ...(existing || {}), ...record, id, recordVersion: nextVersion };
  await client.query(
    `insert into collection_records_v2 (state_key, collection_name, record_id, record_version, data)
     values ($1,$2,$3,$4,$5::jsonb)
     on conflict (state_key, collection_name, record_id) do update
     set record_version = excluded.record_version,
         data = excluded.data,
         updated_at = now()`,
    [key, "teacherStudentNotes", id, nextVersion, JSON.stringify(data)]
  );
  return data;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;

  try {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    const body = await readJson(req);
    const key = stateKey(req, body);
    const teachers = await loadTeachersForTokenCheck(key);
    if (!teachers) return sendJson(res, 404, { ok: false, error: "Timetable data is not ready yet." });

    const teacherId = String(body.teacherId || "").trim();
    const teacher = findTeacher(teachers, teacherId);
    if (!teacher) return sendJson(res, 404, { ok: false, error: "Teacher not found." });
    if (!hasTeacherToken(body.token, teacher)) return sendJson(res, 401, { ok: false, error: "Invalid teacher link token." });

    const records = Array.isArray(body.records) ? body.records : [];
    const now = new Date().toISOString();
    const preparedRecords = records
      .map(record => {
        const studentId = String(record.studentId || "").trim();
        const studentName = cleanStudentName(record.studentName || "");
        if (!studentId && !studentName) return null;
        const id = studentNoteId(teacherId, studentId, studentName);
        return {
          id,
          teacherId,
          studentId,
          studentName,
          currentLevel: String(record.currentLevel || "").slice(0, 200),
          remark: String(record.remark || "").slice(0, 3000),
          archived: Boolean(record.archived),
          createdAt: record.createdAt || now,
          lastUpdatedAt: now,
          lastUpdatedBy: teacher.name || "Teacher"
        };
      })
      .filter(Boolean);

    const pool = getPool();
    const client = await pool.connect();
    let saved = [];
    let versionRow = null;
    try {
      await client.query("begin");
      saved = [];
      for (const record of preparedRecords) {
        saved.push(await upsertTeacherStudentNote(client, key, record));
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
      versionRow = versionRows.rows[0];
      await client.query(
        `insert into audit_logs (action, entity_type, entity_id, summary, after_data, created_by)
         values ('teacher_student_note_saved', 'teacher_student_note', $1, $2, $3::jsonb, $4)`,
        [
          key,
          `Teacher student notes saved for Teacher: ${teacher.name || teacherId}`,
          JSON.stringify({ version: Number(versionRow.version || 0), noteCount: saved.length }),
          `Teacher: ${teacher.name || teacherId}`
        ]
      );
      await client.query("commit");
    } catch (error) {
      try { await client.query("rollback"); } catch (rollbackError) {}
      throw error;
    } finally {
      client.release();
    }

    return sendJson(res, 200, {
      ok: true,
      key,
      version: Number(versionRow?.version || 0),
      updatedAt: versionRow?.updated_at || now,
      updatedBy: `Teacher: ${teacher.name || teacherId}`
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
