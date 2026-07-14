const crypto = require("node:crypto");
const { getSql, ensureCoreTables } = require("../lib/db");
const { setCors, sendJson, handleOptions, requireApiKey, readJson, safeError } = require("../lib/http");

const BUSINESS_COLLECTIONS = [
  "teachers",
  "students",
  "bookings",
  "leads",
  "tutorLeads",
  "crmHistoricalMonthlyStats",
  "replacements",
  "replacementCredits",
  "teacherLeaves",
  "publicHolidays",
  "policyRules",
  "revenueEntries",
  "teacherStudentNotes",
  "teacherFeedback",
  "activityLogs",
  "users",
  "roles"
];

function stateKey(req, body) {
  return String((body && body.key) || (req.query && req.query.key) || "production").trim() || "production";
}

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function roleByName(state, name) {
  return (state.roles || []).find(role => role && role.name === name) || null;
}

function userByEmail(state, email) {
  const users = Array.isArray(state && state.users) ? state.users : [];
  return users.find(item => normalizedEmail(item.email) === email && item.status !== "disabled") || null;
}

function userCanWrite(state, email) {
  const users = Array.isArray(state && state.users) ? state.users : [];
  if (!users.length) return true;
  const hasValidMaster = users.some(item => item && item.role === "master_admin" && item.status !== "disabled" && normalizedEmail(item.email));
  if (!hasValidMaster && email === "master@classone.local") return true;
  const user = userByEmail(state, email);
  if (!user) return false;
  if (user.role === "master_admin") return true;
  const role = roleByName(state, user.role);
  return Array.isArray(role && role.permissions) && role.permissions.includes("save");
}

function userCanManageUsers(state, email) {
  const users = Array.isArray(state && state.users) ? state.users : [];
  if (!users.length && email === "master@classone.local") return true;
  const user = userByEmail(state, email);
  if (!user) return false;
  if (user.role === "master_admin") return true;
  const role = roleByName(state, user.role);
  return Array.isArray(role && role.permissions) && role.permissions.includes("user_management");
}

function usersOrRolesPatched(patch) {
  return Boolean((patch?.changes?.users || []).length || (patch?.changes?.roles || []).length);
}

function verifiedSessionEmail(req, body = {}) {
  const token = String(req.headers["x-user-session"] || body.userSession || "");
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return "";
  const expected = crypto.createHmac("sha256", process.env.API_SECRET || "").update(payload).digest("base64url");
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return "";
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return "";
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (Number(data.exp || 0) < Date.now()) return "";
    return normalizedEmail(data.email);
  } catch (error) {
    return "";
  }
}

function recordIdForPatch(record, collectionName) {
  if (record && record.id) return String(record.id);
  return `${collectionName}_${crypto.createHash("sha1").update(JSON.stringify(record || {})).digest("hex")}`;
}

function activityTime(value) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function recordTime(record) {
  if (!record) return 0;
  return Math.max(
    activityTime(record.updatedAt),
    activityTime(record.statusChangedAt),
    activityTime(record.changedAt),
    activityTime(record.changedSlot && record.changedSlot.changedAt),
    activityTime(record.rebookedAt),
    activityTime(record.cancelledAt),
    activityTime(record.completedAt),
    activityTime(record.studentNotShowAt),
    activityTime(record.deletedAt),
    activityTime(record.createdAt)
  );
}

function localRecordWins(candidate, existing, id) {
  const candidateTime = recordTime(candidate);
  const existingTime = recordTime(existing);
  if (candidateTime !== existingTime) return candidateTime > existingTime;
  const candidateTie = `${candidate?.deviceId || ""}|${id}`;
  const existingTie = `${existing?.deviceId || ""}|${id}`;
  return candidateTie >= existingTie;
}

function mergeList(remoteList, patchList, collectionName) {
  const result = Array.isArray(remoteList) ? remoteList.map(item => ({ ...item })) : [];
  const indexById = new Map(result.map((record, index) => [recordIdForPatch(record, collectionName), index]));
  (Array.isArray(patchList) ? patchList : []).forEach(record => {
    if (!record || typeof record !== "object") return;
    const id = recordIdForPatch(record, collectionName);
    if (!indexById.has(id)) {
      indexById.set(id, result.length);
      result.push(record);
      return;
    }
    const index = indexById.get(id);
    if (localRecordWins(record, result[index], id)) result[index] = record;
  });
  return result;
}

function settingRevisionTime(revision) {
  return activityTime(revision?.updatedAt || revision?.changedAt || revision?.createdAt);
}

function mergeSettings(remoteSettings = {}, patchSettings = null) {
  const remote = remoteSettings && typeof remoteSettings === "object" ? { ...remoteSettings } : {};
  if (!patchSettings) return remote;
  const fields = patchSettings.fields || {};
  const fieldRevisions = patchSettings.fieldRevisions || {};
  const revisions = { ...(remote.settingsFieldRevisions || {}) };
  Object.entries(fields).forEach(([key, value]) => {
    const localRevision = fieldRevisions[key] || {
      updatedAt: patchSettings.updatedAt,
      updatedBy: patchSettings.updatedBy,
      deviceId: patchSettings.deviceId
    };
    const remoteRevision = revisions[key] || {};
    const localTime = settingRevisionTime(localRevision);
    const remoteTime = settingRevisionTime(remoteRevision);
    const localTie = `${localRevision.deviceId || ""}|${key}|${localRevision.updatedBy || ""}`;
    const remoteTie = `${remoteRevision.deviceId || ""}|${key}|${remoteRevision.updatedBy || ""}`;
    if (!(key in remote) || localTime > remoteTime || (localTime === remoteTime && localTie >= remoteTie)) {
      remote[key] = value;
      revisions[key] = localRevision;
    }
  });
  if (Object.keys(revisions).length) remote.settingsFieldRevisions = revisions;
  return remote;
}

function mergePatchIntoState(currentState = {}, patch = {}) {
  const merged = { ...(currentState || {}) };
  BUSINESS_COLLECTIONS.forEach(collectionName => {
    merged[collectionName] = mergeList(merged[collectionName], patch.changes?.[collectionName], collectionName);
  });
  merged.settings = mergeSettings(merged.settings || {}, patch.settings || null);
  return merged;
}

function splitText(text, chunkSize = 350000) {
  const chunks = [];
  for (let index = 0; index < text.length; index += chunkSize) chunks.push(text.slice(index, index + chunkSize));
  return chunks.length ? chunks : [""];
}

function affectedTeacherIdsFromPatch(patch = {}) {
  const ids = new Set();
  ["bookings", "replacements", "teacherLeaves", "teacherFeedback"].forEach(collectionName => {
    (patch.changes?.[collectionName] || []).forEach(record => {
      if (record?.teacherId) ids.add(String(record.teacherId));
      if (record?.replacementTeacherId) ids.add(String(record.replacementTeacherId));
      if (record?.originalTeacherId) ids.add(String(record.originalTeacherId));
    });
  });
  (patch.changes?.teachers || []).forEach(record => record?.id && ids.add(String(record.id)));
  return [...ids];
}

async function applyPatch(req, res) {
  await ensureCoreTables();
  const body = await readJson(req);
  const key = stateKey(req, body);
  const patch = body.patch;
  const updatedBy = String(body.updatedBy || "app").slice(0, 120);
  if (!patch || patch.format !== "classone_record_patch_v1" || typeof patch !== "object") {
    return sendJson(res, 400, { ok: false, error: "Body must include a classone_record_patch_v1 patch." });
  }

  const sql = getSql();
  const rows = await sql`select data, version from app_state where key = ${key} limit 1`;
  const currentState = rows.length ? (rows[0].data || {}) : {};
  const currentVersion = rows.length ? Number(rows[0].version || 0) : 0;
  const email = verifiedSessionEmail(req, body);
  if (!userCanWrite(currentState, email)) {
    return sendJson(res, 403, { ok: false, error: "You do not have permission to save changes." });
  }
  if (usersOrRolesPatched(patch) && !userCanManageUsers(currentState, email)) {
    return sendJson(res, 403, { ok: false, error: "Only master_admin can manage users and roles." });
  }

  const merged = mergePatchIntoState(currentState, patch);
  const expectedVersion = currentVersion;
  const chunks = splitText(JSON.stringify(merged));
  const publishedChunks = JSON.stringify(chunks.map((chunk, index) => ({
    chunk_index: index,
    chunk_data: chunk
  })));
  const savedRows = await sql`
    with saved as (
      insert into app_state (key, data, version, updated_by)
      values (${key}, ${JSON.stringify(merged)}::jsonb, 1, ${updatedBy})
      on conflict (key) do update
      set data = excluded.data,
          version = app_state.version + 1,
          updated_at = now(),
          updated_by = excluded.updated_by
      where app_state.version = ${expectedVersion}
      returning key, version, updated_at, updated_by
    ),
    removed_old_chunks as (
      delete from app_state_text_chunks chunks
      where chunks.state_key = ${key}
        and exists (select 1 from saved)
      returning chunks.state_key
    ),
    inserted_chunks as (
      insert into app_state_text_chunks (state_key, version, chunk_index, chunk_data)
      select saved.key,
             saved.version,
             (item ->> 'chunk_index')::integer,
             item ->> 'chunk_data'
      from saved
      cross join jsonb_array_elements(${publishedChunks}::jsonb) item
      returning chunk_index
    )
    select saved.key,
           saved.version,
           saved.updated_at,
           saved.updated_by,
           (select count(*)::int from inserted_chunks) as published_chunks
    from saved
  `;
  if (!savedRows.length) {
    const current = await sql`select version from app_state where key = ${key} limit 1`;
    return sendJson(res, 409, {
      ok: false,
      error: "Version conflict. Please retry with the latest data.",
      currentVersion: current.length ? Number(current[0].version || 0) : 0
    });
  }
  const saved = savedRows[0];
  const totalChunks = Number(saved.published_chunks || 0);
  if (totalChunks !== chunks.length) {
    throw new Error(`Patch chunk publication failed. Published ${totalChunks} of ${chunks.length}.`);
  }
  const affectedTeacherIds = affectedTeacherIdsFromPatch(patch);
  await sql`
    insert into audit_logs (action, entity_type, entity_id, summary, after_data, created_by)
    values (
      'app_state_patch_saved',
      'app_state',
      ${key},
      ${`Patched app state ${key}`},
      ${JSON.stringify({ version: Number(saved.version || 0), affectedTeacherIds, totalChunks })}::jsonb,
      ${updatedBy}
    )
  `;
  return sendJson(res, 200, {
    ok: true,
    key: saved.key,
    version: Number(saved.version || 0),
    updatedAt: saved.updated_at,
    updatedBy: saved.updated_by || null,
    totalChunks,
    affectedTeacherIds,
    mergedFromNewerVersion: Number(patch.baseVersion || 0) !== currentVersion
  });
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;

  try {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    return await applyPatch(req, res);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
