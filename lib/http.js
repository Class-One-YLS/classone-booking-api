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

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.end(JSON.stringify(body));
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
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 15 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
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
