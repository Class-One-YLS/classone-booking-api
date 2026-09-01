const { getSql, ensureCoreTables } = require("../lib/db");
const { setCors, sendJson, handleOptions, readJson, safeError } = require("../lib/http");

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function stateKey(req, body = {}) {
  return cleanText(body.key || (req.query && req.query.key) || "production", 100) || "production";
}

function validMonthKey(value) {
  const monthKey = cleanText(value, 7);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey) ? monthKey : "";
}

function cleanReward(value, quantityEnabled = false) {
  const claimed = Boolean(value && value.claimed);
  const quantity = quantityEnabled ? Math.max(1, Math.min(100, Number(value && value.quantity) || 1)) : 1;
  return {
    claimed,
    quantity,
    remark: cleanText(value && value.remark, 1000)
  };
}

function cleanClaim(value) {
  return {
    email: cleanText(value.email, 300),
    bankName: cleanText(value.bankName, 200),
    accountName: cleanText(value.accountName, 200),
    accountNumber: cleanText(value.accountNumber, 100),
    birthday: cleanReward(value.birthday),
    bestTeacher: cleanReward(value.bestTeacher),
    googleReview: cleanReward(value.googleReview, true),
    trialEnrollment: cleanReward(value.trialEnrollment, true)
  };
}

async function ensureClaimTable() {
  await ensureCoreTables();
  const sql = getSql();
  await sql`
    create table if not exists teacher_incentive_claims (
      state_key text not null,
      teacher_id text not null,
      month_key text not null,
      claim_data jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now(),
      updated_by text,
      primary key (state_key, teacher_id, month_key)
    )
  `;
  return sql;
}

async function authenticatedTeacher(sql, key, teacherId, token) {
  const rows = await sql`
    select teacher.value as teacher
    from app_state state
    cross join lateral jsonb_array_elements(coalesce(state.data->'teachers', '[]'::jsonb)) as teacher(value)
    where state.key = ${key}
      and teacher.value->>'id' = ${teacherId}
    limit 1
  `;
  const teacher = rows[0] && rows[0].teacher;
  if (!teacher) return { error: "Teacher not found.", status: 404 };
  const savedToken = cleanText(teacher.viewToken || teacher.timetableToken || teacher.shareToken, 500);
  if (!savedToken || savedToken !== cleanText(token, 500)) return { error: "Invalid teacher link token.", status: 401 };
  return { teacher };
}

function validateClaim(claim) {
  const rewards = [
    ["Birthday", claim.birthday],
    ["Monthly Best Teacher", claim.bestTeacher],
    ["Google Review", claim.googleReview],
    ["Trial to Enrollment", claim.trialEnrollment]
  ];
  const missing = rewards.find(([, reward]) => reward.claimed && !reward.remark);
  return missing ? `${missing[0]} requires a remark or reference.` : "";
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (handleOptions(req, res)) return;

  try {
    if (!["GET", "POST"].includes(req.method)) return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    const body = req.method === "POST" ? await readJson(req) : {};
    const key = stateKey(req, body);
    const teacherId = cleanText(body.teacherId || (req.query && req.query.teacherId), 200);
    const token = body.token || (req.query && req.query.token);
    const monthKey = validMonthKey(body.monthKey || (req.query && req.query.monthKey));
    if (!teacherId || !monthKey) return sendJson(res, 400, { ok: false, error: "Teacher and claim month are required." });

    const sql = await ensureClaimTable();
    const auth = await authenticatedTeacher(sql, key, teacherId, token);
    if (auth.error) return sendJson(res, auth.status, { ok: false, error: auth.error });

    if (req.method === "GET") {
      const rows = await sql`
        select claim_data, updated_at, updated_by
        from teacher_incentive_claims
        where state_key = ${key} and teacher_id = ${teacherId} and month_key = ${monthKey}
        limit 1
      `;
      return sendJson(res, 200, {
        ok: true,
        claim: rows[0] ? rows[0].claim_data : null,
        updatedAt: rows[0] ? rows[0].updated_at : null,
        updatedBy: rows[0] ? rows[0].updated_by : null
      });
    }

    const claim = cleanClaim(body.claim || {});
    const validationError = validateClaim(claim);
    if (validationError) return sendJson(res, 400, { ok: false, error: validationError });

    if (claim.birthday.claimed) {
      const yearPrefix = `${monthKey.slice(0, 4)}-%`;
      const duplicates = await sql`
        select month_key
        from teacher_incentive_claims
        where state_key = ${key}
          and teacher_id = ${teacherId}
          and month_key like ${yearPrefix}
          and month_key <> ${monthKey}
          and coalesce(claim_data->'birthday'->>'claimed', 'false') = 'true'
        limit 1
      `;
      if (duplicates.length) {
        return sendJson(res, 409, { ok: false, error: `Birthday reward was already claimed for ${duplicates[0].month_key}.` });
      }
    }

    const teacherName = cleanText(auth.teacher.name, 200) || teacherId;
    const rows = await sql`
      insert into teacher_incentive_claims (state_key, teacher_id, month_key, claim_data, updated_at, updated_by)
      values (${key}, ${teacherId}, ${monthKey}, ${JSON.stringify(claim)}::jsonb, now(), ${`Teacher: ${teacherName}`})
      on conflict (state_key, teacher_id, month_key)
      do update set claim_data = excluded.claim_data, updated_at = now(), updated_by = excluded.updated_by
      returning claim_data, updated_at, updated_by
    `;
    await sql`
      insert into audit_logs (action, entity_type, entity_id, summary, after_data, created_by)
      values (
        'teacher_incentive_claim_saved',
        'teacher_incentive_claim',
        ${`${teacherId}:${monthKey}`},
        ${`Incentive claim saved for ${teacherName}, ${monthKey}`},
        ${JSON.stringify(claim)}::jsonb,
        ${`Teacher: ${teacherName}`}
      )
    `;
    return sendJson(res, 200, {
      ok: true,
      claim: rows[0].claim_data,
      updatedAt: rows[0].updated_at,
      updatedBy: rows[0].updated_by
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: safeError(error) });
  }
};
