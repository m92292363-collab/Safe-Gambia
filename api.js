// ============================================================
// SAFE — single API function (Netlify Functions v2, ESM)
// Env vars required on Netlify:
//   DATABASE_URL  -> Neon connection string
//   APP_SECRET    -> any long random string (signs login tokens)
// ============================================================
import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

const sql = neon(process.env.DATABASE_URL);
const SECRET = process.env.APP_SECRET || 'change-me';

const COMMISSION_BPS = 100;        // agents earn 1% on cash-in & cash-out
const MAX_TX = 50000 * 100;        // per-transaction cap: D 50,000 (in bututs)
const LOCK_AFTER = 5;              // wrong PINs before lockout
const LOCK_MINUTES = 15;

// ---------- helpers ----------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const fail = (msg, status = 400) => json({ ok: false, error: msg }, status);

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `${salt}:${h}`;
}
function verifyPin(pin, stored) {
  const [salt, h] = String(stored).split(':');
  const test = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(test, 'hex'));
}
function signToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, role: user.role, exp: Date.now() + 1000 * 60 * 60 * 12 })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readToken(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (sig !== expect) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (Date.now() > data.exp) return null;
  return data; // { id, role }
}

// Re-check the caller's PIN before money leaves their account.
async function confirmPin(userId, pin) {
  if (!/^[0-9]{4}$/.test(String(pin || ''))) return false;
  const rows = await sql`SELECT pin_hash FROM users WHERE id = ${userId}`;
  return rows.length && verifyPin(pin, rows[0].pin_hash);
}

const normPhone = (p) => {
  let s = String(p || '').replace(/[\s-]/g, '');
  if (/^[0-9]{7}$/.test(s)) s = '+220' + s;
  if (/^220[0-9]{7}$/.test(s)) s = '+' + s;
  return s;
};
const validPhone = (p) => /^\+220[0-9]{7}$/.test(p);
const toBututs = (amountGmd) => {
  const n = Number(amountGmd);
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
};
const newRef = () => 'SF-' + crypto.randomBytes(4).toString('hex').toUpperCase();

// ---------- handler ----------
export default async (req) => {
  if (req.method !== 'POST') return fail('POST only', 405);
  let body;
  try { body = await req.json(); } catch { return fail('Bad JSON'); }
  const action = body.action;

  try {
    // ---------- PUBLIC ----------
    if (action === 'register') {
      const phone = normPhone(body.phone);
      if (!validPhone(phone)) return fail('Enter a valid Gambian number, e.g. 3001122');
      if (!body.name || String(body.name).trim().length < 2) return fail('Enter your full name');
      if (!/^[0-9]{4}$/.test(String(body.pin))) return fail('PIN must be exactly 4 digits');
      const exists = await sql`SELECT 1 FROM users WHERE phone = ${phone}`;
      if (exists.length) return fail('This number is already registered. Try logging in.');
      const rows = await sql`
        INSERT INTO users (phone, name, pin_hash)
        VALUES (${phone}, ${String(body.name).trim()}, ${hashPin(body.pin)})
        RETURNING id, phone, name, role, balance, commission, status, business_name, merchant_code`;
      const user = rows[0];
      return json({ ok: true, token: signToken(user), user });
    }

    if (action === 'login') {
      const phone = normPhone(body.phone);
      const rows = await sql`SELECT * FROM users WHERE phone = ${phone}`;
      if (!rows.length) return fail('Wrong number or PIN');
      const user = rows[0];
      if (user.locked_until && new Date(user.locked_until) > new Date())
        return fail(`Too many wrong PINs. Try again in a few minutes.`);
      if (!verifyPin(body.pin, user.pin_hash)) {
        // count the failure; lock after too many
        await sql`
          UPDATE users SET
            locked_until = CASE WHEN failed_attempts + 1 >= ${LOCK_AFTER}
                                THEN now() + make_interval(mins => ${LOCK_MINUTES})
                                ELSE locked_until END,
            failed_attempts = CASE WHEN failed_attempts + 1 >= ${LOCK_AFTER}
                                   THEN 0 ELSE failed_attempts + 1 END
          WHERE id = ${user.id}`;
        return fail('Wrong number or PIN');
      }
      if (user.status === 'frozen') return fail('This account is frozen. Contact support.');
      await sql`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ${user.id}`;
      delete user.pin_hash;
      return json({ ok: true, token: signToken(user), user });
    }

    // ---------- AUTH REQUIRED ----------
    const auth = readToken(req);
    if (!auth) return fail('Session expired. Please log in again.', 401);

    if (action === 'me') {
      const rows = await sql`
        SELECT id, phone, name, role, balance, commission, status, business_name, merchant_code
        FROM users WHERE id = ${auth.id}`;
      if (!rows.length) return fail('Account not found', 404);
      if (rows[0].status === 'frozen') return fail('This account is frozen.', 403);
      return json({ ok: true, user: rows[0] });
    }

    if (action === 'lookup') {
      const phone = normPhone(body.phone);
      const rows = await sql`
        SELECT name FROM users WHERE phone = ${phone} AND status = 'active'`;
      if (!rows.length) return fail('No active account with that number');
      return json({ ok: true, name: rows[0].name });
    }

    if (action === 'merchant_lookup') {
      const code = String(body.code || '').trim();
      const rows = await sql`
        SELECT business_name FROM users
        WHERE merchant_code = ${code} AND role = 'merchant' AND status = 'active'`;
      if (!rows.length) return fail('No shop found with that code');
      return json({ ok: true, business_name: rows[0].business_name });
    }

    // ----- customer: send money (PIN confirmed) -----
    if (action === 'send') {
      const amount = toBututs(body.amount);
      if (!amount) return fail('Enter a valid amount');
      if (amount < 100) return fail('Minimum send is D 1.00');
      if (amount > MAX_TX) return fail('Maximum per transaction is D 50,000');
      const toPhone = normPhone(body.to);
      if (!validPhone(toPhone)) return fail('Enter a valid receiver number');
      if (!(await confirmPin(auth.id, body.pin))) return fail('Wrong PIN');
      const ref = newRef();
      // Atomic: verify receiver first, then debit, then credit, then record.
      // If ANY step finds nothing, nothing is inserted and every change is conditional — no half-transfers.
      const rows = await sql`
        WITH target AS (
          SELECT id FROM users
          WHERE phone = ${toPhone} AND status = 'active' AND id <> ${auth.id}
        ),
        sender AS (
          UPDATE users SET balance = balance - ${amount}
          WHERE id = ${auth.id} AND status = 'active' AND balance >= ${amount}
            AND EXISTS (SELECT 1 FROM target)
          RETURNING id
        ),
        receiver AS (
          UPDATE users SET balance = balance + ${amount}
          WHERE id = (SELECT id FROM target)
            AND EXISTS (SELECT 1 FROM sender)
          RETURNING id
        )
        INSERT INTO transactions (ref, type, from_id, to_id, amount, note)
        SELECT ${ref}, 'send', s.id, r.id, ${amount}, ${body.note || null}
        FROM sender s, receiver r
        RETURNING ref`;
      if (!rows.length)
        return fail('Transfer failed — check your balance and the receiver number.');
      return json({ ok: true, ref: rows[0].ref });
    }

    // ----- customer: pay a shop (PIN confirmed) -----
    if (action === 'pay') {
      const amount = toBututs(body.amount);
      if (!amount) return fail('Enter a valid amount');
      if (amount > MAX_TX) return fail('Maximum per transaction is D 50,000');
      const code = String(body.code || '').trim();
      if (!/^[0-9]{6}$/.test(code)) return fail('Enter the shop\'s 6-digit code');
      if (!(await confirmPin(auth.id, body.pin))) return fail('Wrong PIN');
      const ref = newRef();
      const rows = await sql`
        WITH shop AS (
          SELECT id, business_name FROM users
          WHERE merchant_code = ${code} AND role = 'merchant'
            AND status = 'active' AND id <> ${auth.id}
        ),
        payer AS (
          UPDATE users SET balance = balance - ${amount}
          WHERE id = ${auth.id} AND status = 'active' AND balance >= ${amount}
            AND EXISTS (SELECT 1 FROM shop)
          RETURNING id
        ),
        credited AS (
          UPDATE users SET balance = balance + ${amount}
          WHERE id = (SELECT id FROM shop)
            AND EXISTS (SELECT 1 FROM payer)
          RETURNING id
        )
        INSERT INTO transactions (ref, type, from_id, to_id, amount, note)
        SELECT ${ref}, 'payment', p.id, c.id, ${amount}, ${body.note || null}
        FROM payer p, credited c
        RETURNING ref, (SELECT business_name FROM shop) AS shop_name`;
      if (!rows.length)
        return fail('Payment failed — check your balance and the shop code.');
      return json({ ok: true, ref: rows[0].ref, shop: rows[0].shop_name });
    }

    if (action === 'history') {
      const rows = await sql`
        SELECT t.ref, t.type, t.amount, t.commission, t.note, t.created_at,
               t.from_id, t.to_id,
               fu.name AS from_name, COALESCE(tu.business_name, tu.name) AS to_name
        FROM transactions t
        LEFT JOIN users fu ON fu.id = t.from_id
        LEFT JOIN users tu ON tu.id = t.to_id
        WHERE t.from_id = ${auth.id} OR t.to_id = ${auth.id}
        ORDER BY t.created_at DESC LIMIT 50`;
      return json({ ok: true, me: auth.id, items: rows });
    }

    // ----- customer: one-time cash-out code -----
    if (action === 'create_code') {
      const amount = toBututs(body.amount);
      if (!amount) return fail('Enter a valid amount');
      if (amount > MAX_TX) return fail('Maximum per transaction is D 50,000');
      const bal = await sql`SELECT balance FROM users WHERE id = ${auth.id} AND status='active'`;
      if (!bal.length || Number(bal[0].balance) < amount)
        return fail('Amount is more than your balance');
      const code = String(crypto.randomInt(100000, 999999));
      await sql`
        INSERT INTO cashout_codes (code, user_id, amount, expires_at)
        VALUES (${code}, ${auth.id}, ${amount}, now() + interval '30 minutes')`;
      return json({ ok: true, code, amount, expires_min: 30 });
    }

    if (action === 'my_codes') {
      const rows = await sql`
        SELECT code, amount, status, expires_at
        FROM cashout_codes WHERE user_id = ${auth.id}
        ORDER BY created_at DESC LIMIT 10`;
      return json({ ok: true, items: rows });
    }

    // ---------- MERCHANT ----------
    if (auth.role === 'merchant') {
      if (action === 'merchant_stats') {
        const [s] = await sql`
          SELECT COALESCE(SUM(amount),0) AS today_total, COUNT(*) AS today_count
          FROM transactions
          WHERE to_id = ${auth.id} AND type = 'payment'
            AND created_at >= date_trunc('day', now())`;
        return json({ ok: true, stats: s });
      }
    }

    // ---------- AGENT ----------
    if (auth.role === 'agent' || auth.role === 'admin') {
      if (action === 'cash_in') {
        const amount = toBututs(body.amount);
        if (!amount) return fail('Enter a valid amount');
        if (amount > MAX_TX) return fail('Maximum per transaction is D 50,000');
        const phone = normPhone(body.phone);
        const comm = Math.floor((amount * COMMISSION_BPS) / 10000);
        const ref = newRef();
        const rows = await sql`
          WITH target AS (
            SELECT id FROM users
            WHERE phone = ${phone} AND status = 'active' AND role = 'customer'
              AND id <> ${auth.id}
          ),
          agent AS (
            UPDATE users SET balance = balance - ${amount} + ${comm},
                             commission = commission + ${comm}
            WHERE id = ${auth.id} AND status = 'active' AND balance >= ${amount}
              AND EXISTS (SELECT 1 FROM target)
            RETURNING id
          ),
          customer AS (
            UPDATE users SET balance = balance + ${amount}
            WHERE id = (SELECT id FROM target)
              AND EXISTS (SELECT 1 FROM agent)
            RETURNING id
          )
          INSERT INTO transactions (ref, type, from_id, to_id, amount, commission)
          SELECT ${ref}, 'cash_in', a.id, c.id, ${amount}, ${comm}
          FROM agent a, customer c
          RETURNING ref`;
        if (!rows.length)
          return fail('Cash-in failed — check your float balance and the customer number.');
        return json({ ok: true, ref: rows[0].ref, commission: comm });
      }

      if (action === 'cash_out') {
        const code = String(body.code || '').trim();
        if (!/^[0-9]{6}$/.test(code)) return fail('Enter the 6-digit code');
        const ref = newRef();
        const rows = await sql`
          WITH redeemed AS (
            UPDATE cashout_codes cc SET status = 'used', used_by = ${auth.id}
            FROM users cu
            WHERE cc.code = ${code} AND cc.status = 'pending' AND cc.expires_at > now()
              AND cu.id = cc.user_id AND cu.status = 'active'
              AND cu.balance >= cc.amount AND cc.user_id <> ${auth.id}
              AND EXISTS (SELECT 1 FROM users ag
                          WHERE ag.id = ${auth.id} AND ag.status = 'active')
            RETURNING cc.user_id, cc.amount
          ),
          customer AS (
            UPDATE users u SET balance = u.balance - r.amount
            FROM redeemed r WHERE u.id = r.user_id
            RETURNING u.id, r.amount
          ),
          agent AS (
            UPDATE users SET
              balance = balance + (SELECT amount FROM customer)
                        + FLOOR((SELECT amount FROM customer) * ${COMMISSION_BPS} / 10000.0),
              commission = commission
                        + FLOOR((SELECT amount FROM customer) * ${COMMISSION_BPS} / 10000.0)
            WHERE id = ${auth.id} AND EXISTS (SELECT 1 FROM customer)
            RETURNING id
          )
          INSERT INTO transactions (ref, type, from_id, to_id, amount, commission)
          SELECT ${ref}, 'cash_out', c.id, a.id, c.amount,
                 FLOOR(c.amount * ${COMMISSION_BPS} / 10000.0)
          FROM customer c, agent a
          RETURNING ref, amount`;
        if (!rows.length)
          return fail('Code invalid, expired, already used, or customer balance too low.');
        return json({ ok: true, ref: rows[0].ref, amount: Number(rows[0].amount) });
      }
    }

    // ---------- ADMIN ----------
    if (auth.role === 'admin') {
      if (action === 'admin_stats') {
        const [stats] = await sql`
          SELECT
            (SELECT COUNT(*) FROM users WHERE role='customer')  AS customers,
            (SELECT COUNT(*) FROM users WHERE role='agent')     AS agents,
            (SELECT COUNT(*) FROM users WHERE role='merchant')  AS merchants,
            (SELECT COALESCE(SUM(balance),0) FROM users)        AS total_float,
            (SELECT COALESCE(SUM(amount),0) FROM transactions
              WHERE created_at > now() - interval '24 hours')   AS volume_24h,
            (SELECT COUNT(*) FROM transactions
              WHERE created_at > now() - interval '24 hours')   AS tx_24h`;
        return json({ ok: true, stats });
      }

      if (action === 'admin_users') {
        const q = '%' + String(body.q || '').trim() + '%';
        const rows = await sql`
          SELECT id, phone, name, role, balance, commission, status,
                 business_name, merchant_code, created_at
          FROM users
          WHERE phone ILIKE ${q} OR name ILIKE ${q} OR business_name ILIKE ${q}
          ORDER BY created_at DESC LIMIT 50`;
        return json({ ok: true, items: rows });
      }

      if (action === 'admin_set_role') {
        if (!['customer', 'agent', 'merchant'].includes(body.role)) return fail('Bad role');
        if (body.role === 'merchant') {
          const bn = String(body.business_name || '').trim();
          if (bn.length < 2) return fail('Enter the shop name');
          for (let i = 0; i < 5; i++) {
            const code = String(crypto.randomInt(100000, 999999));
            try {
              const r = await sql`
                UPDATE users SET role = 'merchant', business_name = ${bn},
                                 merchant_code = COALESCE(merchant_code, ${code})
                WHERE id = ${body.user_id} AND role <> 'admin'
                RETURNING merchant_code`;
              if (!r.length) return fail('User not found');
              return json({ ok: true, merchant_code: r[0].merchant_code });
            } catch { /* code collision — retry with a new one */ }
          }
          return fail('Please try again');
        }
        await sql`UPDATE users SET role = ${body.role}
                  WHERE id = ${body.user_id} AND role <> 'admin'`;
        return json({ ok: true });
      }

      if (action === 'admin_set_status') {
        if (!['active', 'frozen'].includes(body.status)) return fail('Bad status');
        await sql`UPDATE users SET status = ${body.status}
                  WHERE id = ${body.user_id} AND role <> 'admin'`;
        return json({ ok: true });
      }

      if (action === 'admin_float_topup') {
        const amount = toBututs(body.amount);
        if (!amount) return fail('Enter a valid amount');
        const ref = newRef();
        const rows = await sql`
          WITH agent AS (
            UPDATE users SET balance = balance + ${amount}
            WHERE id = ${body.user_id} AND role = 'agent' AND status = 'active'
            RETURNING id
          )
          INSERT INTO transactions (ref, type, from_id, to_id, amount, note)
          SELECT ${ref}, 'float_topup', NULL, a.id, ${amount}, 'Admin float top-up'
          FROM agent a RETURNING ref`;
        if (!rows.length) return fail('User is not an active agent');
        return json({ ok: true, ref: rows[0].ref });
      }
    }

    return fail('Unknown action or not allowed', 403);
  } catch (err) {
    console.error(err);
    return fail('Server error — please try again.', 500);
  }
};

export const config = { path: '/api' };
