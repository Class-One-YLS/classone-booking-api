const { ensureCoreTables } = require("../../lib/db");
const { backfillRecurringAssignmentsFromAppState, recurringAssignmentBackfillStatus, stateKey } = require("../../lib/composed-state");
const { setCors, sendJson, handleOptions, requireApiKey, safeError } = require("../../lib/http");

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;
  try {
    await ensureCoreTables();
    const key = stateKey(req);
    if (req.method === "GET") {
      const result = await recurringAssignmentBackfillStatus(key);
      return sendJson(res, 200, { ok: true, key, ...result });
    }
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    const result = await backfillRecurringAssignmentsFromAppState(key);
    const status = await recurringAssignmentBackfillStatus(key);
    return sendJson(res, 200, { ok: true, key, ...result, status });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
