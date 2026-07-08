const crypto = require("node:crypto");
const { getSql, ensureCoreTables } = require("../lib/db");
const { setCors, sendJson, handleOptions, requireApiKey, readJson, safeError } = require("../lib/http");

function stateKey(req, body) {
  return String((body && body.key) || (req.query && req.query.key) || "production").trim() || "production";
}

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function roleByName(state, name) {
  return (state.roles || []).find(role => role && role.name === name) || null;
}

function userCanWrite(state, email) {
  const users = Array.isArray(state && state.users) ? state.users : [];
  if (!users.length) return true;
  const hasValidMaster = users.some(item => item && item.role === "master_admin" && item.status !== "disabled" && normalizedEmail(item.email));
  if (!hasValidMaster && email === "master@classone.local") return true;
  const user = users.find(item => normalizedEmail(item.email) === email && item.status !== "disabled");
  if (!user) return false;
  if (user.role === "master_admin") return true;
  const role = roleByName(state, user.role);
  return Array.isArray(role && role.permissions) && role.permissions.includes("save");
}

function verifiedSessionEmail(req) {
  const token = String(req.headers["x-user-session"] || "");
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

async function requireWritePermission(req, res, key) {
  const sql = getSql();
  const rows = await sql`select data from app_state where key = ${key} limit 1`;
  if (!rows.length) return true;
  const current = rows[0].data || {};
  if (userCanWrite(current, verifiedSessionEmail(req))) return true;
  sendJson(res, 403, { ok: false, error: "You do not have permission to save changes." });
  return false;
}

function splitText(text, chunkSize = 350000) {
  const chunks = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks.length ? chunks : [""];
}

async function getManifest(req, res) {
  await ensureCoreTables();
  const sql = getSql();
  const key = stateKey(req);
  const rows = await sql`
    select key, version, updated_at, updated_by
    from app_state
    where key = ${key}
    limit 1
  `;
  if (!rows.length) {
    return sendJson(res, 200, { ok: true, key, empty: true, version: 0, totalChunks: 0, updatedAt: null, updatedBy: null });
  }
  const row = rows[0];
  const countRows = await sql`
    select count(*)::int as count
    from app_state_text_chunks
    where state_key = ${key} and version = ${row.version}
  `;
  let totalChunks = Number(countRows[0].count || 0);
  if (!totalChunks) {
    const stateRows = await sql`select data::text as data_text from app_state where key = ${key} limit 1`;
    const chunks = splitText(stateRows[0].data_text || "{}");
    await sql`delete from app_state_text_chunks where state_key = ${key} and version = ${row.version}`;
    for (let index = 0; index < chunks.length; index += 1) {
      await sql`
        insert into app_state_text_chunks (state_key, version, chunk_index, chunk_data)
        values (${key}, ${row.version}, ${index}, ${chunks[index]})
      `;
    }
    totalChunks = chunks.length;
  }
  return sendJson(res, 200, {
    ok: true,
    key,
    empty: false,
    version: Number(row.version || 0),
    totalChunks,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by || null
  });
}

async function getChunk(req, res) {
  await ensureCoreTables();
  const sql = getSql();
  const key = stateKey(req);
  const version = Number(req.query.version || 0);
  const index = Number(req.query.chunk || 0);
  if (!Number.isInteger(index) || index < 0) return sendJson(res, 400, { ok: false, error: "Invalid chunk index." });

  const rows = await sql`
    select chunk_data
    from app_state_text_chunks
    where state_key = ${key} and version = ${version} and chunk_index = ${index}
    limit 1
  `;
  if (!rows.length) return sendJson(res, 404, { ok: false, error: "Chunk not found." });
  return sendJson(res, 200, { ok: true, key, version, index, chunk: rows[0].chunk_data });
}

async function initUpload(req, body, res) {
  await ensureCoreTables();
  const sql = getSql();
  const uploadId = crypto.randomUUID();
  const key = stateKey({}, body);
  if (!(await requireWritePermission(req, res, key))) return;
  const totalChunks = Number(body.totalChunks || 0);
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 5000) {
    return sendJson(res, 400, { ok: false, error: "Invalid totalChunks." });
  }
  await sql`
    insert into app_state_uploads (upload_id, state_key, expected_version, updated_by, total_chunks)
    values (${uploadId}, ${key}, ${body.expectedVersion == null ? null : Number(body.expectedVersion)}, ${body.updatedBy || "app"}, ${totalChunks})
  `;
  return sendJson(res, 200, { ok: true, uploadId, key, totalChunks });
}

async function saveUploadChunk(req, body, res) {
  await ensureCoreTables();
  const sql = getSql();
  const uploadId = String(body.uploadId || "");
  const index = Number(body.index);
  const chunk = String(body.chunk || "");
  if (!uploadId) return sendJson(res, 400, { ok: false, error: "uploadId is required." });
  if (!Number.isInteger(index) || index < 0) return sendJson(res, 400, { ok: false, error: "Invalid chunk index." });
  if (chunk.length > 750000) return sendJson(res, 413, { ok: false, error: "Chunk is too large." });
  const uploadRows = await sql`select state_key, total_chunks from app_state_uploads where upload_id = ${uploadId} limit 1`;
  if (!uploadRows.length) return sendJson(res, 404, { ok: false, error: "Upload not found." });
  if (!(await requireWritePermission(req, res, uploadRows[0].state_key))) return;
  if (index >= Number(uploadRows[0].total_chunks || 0)) return sendJson(res, 400, { ok: false, error: "Chunk index exceeds total chunks." });
  await sql`
    insert into app_state_upload_chunks (upload_id, chunk_index, chunk_data)
    values (${uploadId}, ${index}, ${chunk})
    on conflict (upload_id, chunk_index) do update
    set chunk_data = excluded.chunk_data,
        created_at = now()
  `;
  return sendJson(res, 200, { ok: true, uploadId, index });
}

async function completeUpload(req, body, res) {
  await ensureCoreTables();
  const sql = getSql();
  const uploadId = String(body.uploadId || "");
  if (!uploadId) return sendJson(res, 400, { ok: false, error: "uploadId is required." });

  const uploadRows = await sql`
    select upload_id, state_key, expected_version, updated_by, total_chunks
    from app_state_uploads
    where upload_id = ${uploadId}
    limit 1
  `;
  if (!uploadRows.length) return sendJson(res, 404, { ok: false, error: "Upload not found." });
  const upload = uploadRows[0];
  if (!(await requireWritePermission(req, res, upload.state_key))) return;
  const chunkRows = await sql`
    select chunk_index, chunk_data
    from app_state_upload_chunks
    where upload_id = ${uploadId}
    order by chunk_index asc
  `;
  if (chunkRows.length !== Number(upload.total_chunks || 0)) {
    return sendJson(res, 400, { ok: false, error: `Upload incomplete. Received ${chunkRows.length} of ${upload.total_chunks} chunks.` });
  }
  for (let index = 0; index < chunkRows.length; index += 1) {
    if (Number(chunkRows[index].chunk_index) !== index) {
      return sendJson(res, 400, { ok: false, error: `Missing chunk ${index}.` });
    }
  }

  const text = chunkRows.map(row => row.chunk_data).join("");
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: "Uploaded chunks do not contain valid JSON." });
  }

  if (upload.expected_version != null) {
    const current = await sql`select version from app_state where key = ${upload.state_key} limit 1`;
    const currentVersion = current.length ? Number(current[0].version || 0) : 0;
    if (currentVersion !== Number(upload.expected_version || 0)) {
      return sendJson(res, 409, { ok: false, error: "Version conflict. Please reload latest data first.", currentVersion });
    }
  }

  const publishedChunks = JSON.stringify(chunkRows.map(row => ({
    chunk_index: Number(row.chunk_index),
    chunk_data: row.chunk_data
  })));
  const expectedVersion = upload.expected_version == null ? null : Number(upload.expected_version);
  const savedRows = await sql`
    with saved as (
      insert into app_state (key, data, version, updated_by)
      values (${upload.state_key}, ${JSON.stringify(data)}::jsonb, 1, ${upload.updated_by || "app"})
      on conflict (key) do update
      set data = excluded.data,
          version = app_state.version + 1,
          updated_at = now(),
          updated_by = excluded.updated_by
      where ${expectedVersion}::bigint is null or app_state.version = ${expectedVersion}
      returning key, version, updated_at, updated_by
    ),
    removed_old_chunks as (
      delete from app_state_text_chunks chunks
      where chunks.state_key = ${upload.state_key}
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
    const current = await sql`select version from app_state where key = ${upload.state_key} limit 1`;
    return sendJson(res, 409, {
      ok: false,
      error: "Version conflict. Please reload latest data first.",
      currentVersion: current.length ? Number(current[0].version || 0) : 0
    });
  }
  const saved = savedRows[0];
  if (Number(saved.published_chunks || 0) !== chunkRows.length) {
    throw new Error(`Chunk publication failed. Published ${saved.published_chunks || 0} of ${chunkRows.length}.`);
  }
  await sql`
    insert into audit_logs (action, entity_type, entity_id, summary, after_data, created_by)
    values (
      'app_state_chunk_saved',
      'app_state',
      ${upload.state_key},
      ${`Saved chunked app state ${upload.state_key}`},
      ${JSON.stringify({ version: Number(saved.version || 0), chunks: chunkRows.length })}::jsonb,
      ${upload.updated_by || "app"}
    )
  `;
  await sql`delete from app_state_uploads where upload_id = ${uploadId}`;
  return sendJson(res, 200, {
    ok: true,
    key: saved.key,
    version: Number(saved.version || 0),
    updatedAt: saved.updated_at,
    updatedBy: saved.updated_by || null,
    totalChunks: chunkRows.length
  });
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;

  try {
    if (req.method === "GET") {
      if (req.query && req.query.chunk != null) return await getChunk(req, res);
      return await getManifest(req, res);
    }
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    const body = await readJson(req);
    if (body.mode === "init") return await initUpload(req, body, res);
    if (body.mode === "chunk") return await saveUploadChunk(req, body, res);
    if (body.mode === "complete") return await completeUpload(req, body, res);
    return sendJson(res, 400, { ok: false, error: "Invalid chunk mode." });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
