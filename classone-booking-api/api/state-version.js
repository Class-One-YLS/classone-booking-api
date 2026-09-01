const { ensureCoreTables } = require("../lib/db");
const { loadComposedState } = require("../lib/composed-state");
const { setCors, sendJson, handleOptions, requireApiKey, safeError } = require("../lib/http");

function stateKey(req) {
  return String((req.query && req.query.key) || "production").trim() || "production";
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;
  if (!requireApiKey(req, res)) return;

  try {
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    await ensureCoreTables();
    const key = stateKey(req);
    const row = await loadComposedState(key, { backfill: false });
    const phase2Status = {
      build: "2026.08.14-phase2-verification.1",
      capabilities: {
        phase1BookingOutcome: true,
        phase2BookingCreate: true,
        phase2RecurringAssignments: true,
        recordTransactions: true,
        composedState: true,
        recurringBackfillStatus: true,
        bookingBackfillStatus: true
      },
      endpoints: {
        bookingOutcome: "/api/bookings/outcome",
        bookingCreate: "/api/bookings/create",
        recurringAssignmentUpsert: "/api/recurring-assignments/upsert",
        recurringAssignmentBackfill: "/api/recurring-assignments/backfill",
        recordTransaction: "/api/records/transaction",
        bookingBackfill: "/api/bookings/backfill",
        teacherView: "/api/teacher-view"
      }
    };
    if (!row.data) return sendJson(res, 200, { ok: true, key, empty: true, version: 0, updatedAt: null, updatedBy: null, composed: true, ...phase2Status });
    return sendJson(res, 200, {
      ok: true,
      key: row.key,
      empty: false,
      version: Number(row.version || 0),
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy || null,
      composed: true,
      ...phase2Status
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
