const { getSql, ensureCoreTables } = require("../lib/db");
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
    const sql = getSql();
    const key = stateKey(req);
    const rawTeacher = String((req.query && (req.query.teacherId || req.query.teacher)) || "").trim();
    if (!rawTeacher) return sendJson(res, 400, { ok: false, error: "Teacher is required." });
    const compactTeacher = compactName(rawTeacher);
    const rows = await sql`
      with source as (
        select key, data, version, updated_at
        from app_state
        where key = ${key}
        limit 1
      )
      select
        source.key,
        source.version,
        source.updated_at,
        jsonb_build_object(
          'id', teacher.value->>'id',
          'viewToken', teacher.value->>'viewToken',
          'timetableToken', teacher.value->>'timetableToken',
          'shareToken', teacher.value->>'shareToken'
        ) as teacher
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
    `;
    if (!rows.length) return sendJson(res, 404, { ok: false, error: "Teacher timetable is not ready yet." });
    const row = rows[0];
    if (!hasTeacherToken(req, row.teacher || {})) return sendJson(res, 401, { ok: false, error: "Teacher timetable link is invalid or not synced yet." });
    return sendJson(res, 200, {
      ok: true,
      key: row.key,
      teacherId: row.teacher.id,
      version: Number(row.version || 0),
      updatedAt: row.updated_at,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
