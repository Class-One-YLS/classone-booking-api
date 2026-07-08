const crypto = require("node:crypto");
const { getSql, ensureCoreTables } = require("../lib/db");
const { setCors, sendJson, handleOptions, requireApiKey, readJson, safeError } = require("../lib/http");

function stateKey(req, body) {
  return String((body && body.key) || (req.query && req.query.key) || "production").trim() || "production";
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signPayload(payload) {
  return crypto.createHmac("sha256", process.env.API_SECRET || "").update(payload).digest("base64url");
}

function makeToken(user) {
  const payload = base64url(JSON.stringify({
    email: String(user.email || "").toLowerCase(),
    role: user.role || "viewer",
    iat: Date.now(),
    exp: Date.now() + (12 * 60 * 60 * 1000)
  }));
  return `${payload}.${signPayload(payload)}`;
}

async function login(req, res) {
  await ensureCoreTables();
  const body = await readJson(req);
  const key = stateKey(req, body);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email) return sendJson(res, 400, { ok: false, error: "Email is required." });

  const sql = getSql();
  const rows = await sql`select data from app_state where key = ${key} limit 1`;
  const state = rows[0]?.data || {};
  const users = Array.isArray(state.users) ? state.users : [];
  const hasValidMaster = users.some(item => item && item.role === "master_admin" && item.status !== "disabled" && String(item.email || "").trim());
  let user = users.find(item => String(item.email || "").trim().toLowerCase() === email && item.status !== "disabled");
  const bootstrapMaster = {
    id: "user_master_admin",
    name: "Master Admin",
    email: "master@classone.local",
    role: "master_admin",
    status: "active"
  };
  const bootstrapAllowed = email === "master@classone.local" && password === "classone2026private" && (!users.length || !hasValidMaster);
  if (!user && bootstrapAllowed) user = bootstrapMaster;
  const storedPassword = String(user && user.password || "");
  const defaultMasterFallback = email === "master@classone.local"
    && user
    && user.role === "master_admin"
    && password === "classone2026private"
    && (bootstrapAllowed || !storedPassword || storedPassword === "classone2026private");
  if (!user || (storedPassword !== password && !defaultMasterFallback)) {
    return sendJson(res, 401, { ok: false, error: "Invalid email or password." });
  }

  return sendJson(res, 200, {
    ok: true,
    token: makeToken(user),
    user: {
      id: user.id || "",
      name: user.name || "",
      email: user.email || "",
      role: user.role || "viewer",
      status: user.status || "active"
    }
  });
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;

  try {
    if (req.method === "POST") return await login(req, res);
    return sendJson(res, 405, { ok: false, error: "Method not allowed." });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
