const zlib = require("node:zlib");

const DEFAULT_ORIGINS = [
  "https://class-one-yls.github.io",
  "null"
];

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(","))
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const origins = allowedOrigins();
  const localPreview = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
  if (origins.includes(origin) || localPreview) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", origins[0] || "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-API-Key,X-User-Email,X-User-Session");
}

// EMERGENCY FIX 2026-09-07: /api/state's composed response for the production key has grown to
// ~9MB of JSON (bookings_records_v2 alone is ~3MB, plus the legacy app_state blob, recurring
// assignments, activity logs, etc. -- see the 2026-09-07 activity_events_v2 64MB incident for the
// related backend fix). Vercel's Node.js serverless functions have a hard, non-configurable
// response-size limit well under that (documented around 4.5MB), so every endpoint returning the
// full composed state was crashing with a generic FUNCTION_INVOCATION_FAILED -- not the JSON error
// this file normally sends, because the crash happens while Vercel's platform tries to flush an
// oversized response, before/regardless of anything sendJson() does.
// This repo's JSON is highly repetitive (many bookings/students/teachers with the same field
// names), so gzip alone commonly shrinks it 80-90%+, comfortably back under the limit. This uses
// `res.req` (a standard Node.js `http.ServerResponse` property pointing back at the originating
// request -- available here without changing every call site's signature) to check the client
// actually accepts gzip before compressing; virtually every browser/fetch call does. Small bodies
// are left uncompressed since gzipping tiny payloads adds overhead for no benefit.
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  const json = JSON.stringify(body);
  try {
    const acceptEncoding = String((res.req && res.req.headers && res.req.headers["accept-encoding"]) || "");
    if (json.length > 4096 && /\bgzip\b/i.test(acceptEncoding)) {
      const compressed = zlib.gzipSync(json);
      res.setHeader("Content-Encoding", "gzip");
      // Append rather than overwrite: setCors() already sets "Vary: Origin" for CORS caching, and
      // clobbering that here (instead of combining) would silently break CORS cache correctness.
      const existingVary = res.getHeader("Vary");
      const varyValues = new Set(String(existingVary || "").split(",").map(v => v.trim()).filter(Boolean));
      varyValues.add("Accept-Encoding");
      res.setHeader("Vary", [...varyValues].join(", "));
      res.end(compressed);
      return;
    }
  } catch (compressionError) {
    // Fall through to uncompressed below if gzip somehow fails -- never let a compression bug
    // block a response that would otherwise have gone out fine.
  }
  res.end(json);
}

function handleOptions(req, res) {
  if (req.method !== "OPTIONS") return false;
  setCors(req, res);
  res.statusCode = 204;
  res.end();
  return true;
}

function requireApiKey(req, res) {
  const configured = process.env.API_SECRET;
  const provided = req.headers["x-api-key"];
  if (!configured) {
    sendJson(res, 500, { ok: false, error: "API_SECRET is not configured." });
    return false;
  }
  if (!provided || provided !== configured) {
    sendJson(res, 401, { ok: false, error: "Invalid API key." });
    return false;
  }
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    const maxBytes = 15 * 1024 * 1024;
    req.on("data", chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > maxBytes) {
        const error = new Error("Request body is too large.");
        error.status = 413;
        error.code = "PATCH_PAYLOAD_TOO_LARGE";
        error.maxBytes = maxBytes;
        error.payloadBytes = Buffer.byteLength(raw, "utf8");
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function safeError(error) {
  return error && error.message ? error.message : "Unexpected server error.";
}

module.exports = {
  setCors,
  sendJson,
  handleOptions,
  requireApiKey,
  readJson,
  safeError
};
