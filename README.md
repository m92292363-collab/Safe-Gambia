# Safe — Setup Guide (step by step)

A money transfer app for The Gambia. Customers send money, pay at shops (QR or shop code — Wave style), and cash out with codes. Agents do cash-in and pay-outs and earn 1% commission. Merchants receive shop payments. Admin controls everything. All amounts are Dalasi (GMD).

Your usual stack: single-file frontend + Netlify Function + Neon Postgres.

---

## Step 1 — Create the database (Neon)

1. Go to https://neon.tech and create a new project. Call it `safe`.
2. Open the **SQL Editor** in Neon.
3. Copy EVERYTHING inside `schema.sql` and paste it into the editor. Click **Run**.
4. Go to your Neon dashboard → **Connection string** → copy it. It looks like:
   `postgresql://user:password@ep-xxxx.neon.tech/neondb?sslmode=require`
   Keep it — you need it in Step 3.

## Step 2 — Push to GitHub

1. Create a new GitHub repo called `safe`.
2. Upload ALL of these files keeping the same folder structure:
   ```
   index.html
   netlify.toml
   package.json
   schema.sql
   migration-2-merchants.sql
   migration-3-otp.sql
   netlify/functions/api.js
   ```
   (The `api.js` MUST be inside `netlify/functions/` — that folder path matters.)

## Step 3 — Deploy on Netlify

⚠️ Use your PRIMARY Netlify account (not the "america"/madxxa1 one).

1. Netlify → **Add new site** → **Import an existing project** → pick the `safe` repo.
2. Leave build settings empty (publish directory = `.`) and deploy.
3. Go to **Site configuration → Environment variables** and add TWO variables:
   - `DATABASE_URL` → paste your Neon connection string from Step 1
   - `APP_SECRET` → any long random text, e.g. `safe-9f83hwd82hd82hd-secret-2026`
     (this signs login sessions — never share it, never change it after launch)
4. Go to **Deploys → Trigger deploy → Deploy site** so the new variables take effect.

## Step 3b — Turn on real SMS codes (FREE, using your own phone)

New accounts must verify their number with a 4-digit code (like Wave).
Until you connect a sender, the app runs in **DEMO MODE**: the code shows
on screen instead of arriving by SMS — perfect for testing.

The FREE way — your Android phone becomes the SMS sender (SMSGate):

1. On a spare or main Android phone, download the app from
   https://sms-gate.app (Download App button — it's free, open source,
   no registration needed).
2. Install it, open it, and switch ON **Cloud server** mode.
3. The app's Home screen shows a **username** and **password** — copy them.
4. In Netlify → Environment variables, add:
   - `SMSGATE_USERNAME`  (from the app)
   - `SMSGATE_PASSWORD`  (from the app)
5. Trigger a new deploy. Done — Safe now texts codes through YOUR phone,
   using YOUR SIM, at your normal Gambian SMS rate (get an SMS bundle and
   it's basically free).

Keep that phone: plugged in, connected to internet, battery optimization
OFF for the SMSGate app (so Android doesn't kill it), and loaded with an
SMS bundle. That phone is now your SMS server.

Good for pilots and hundreds of users. If Safe grows big, carriers may
limit one SIM sending thousands of texts — at that point add Twilio as
backup (the code already supports it: set `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_FROM` and it's used automatically if your
phone fails).

SMS safety built in: codes are hashed in the database, expire in 5 minutes,
max 5 wrong tries per code, and max 3 codes per number per 10 minutes.

## Step 4 — Make yourself admin

1. Open your live site and **Create account** with your own phone number.
2. Go back to the Neon SQL Editor and run (with YOUR number):
   ```sql
   UPDATE users SET role = 'admin' WHERE phone = '+2203001122';
   ```
3. In the app, log out and log back in. You now see the admin dashboard.

## Already deployed the first version?

If your Neon database already has the original tables, DON'T re-run schema.sql.
Instead run `migration-2-merchants.sql` and `migration-3-otp.sql` once each in the Neon SQL Editor — it adds the
merchant columns and security columns without touching your data. Then push the
updated `index.html` and `api.js` to GitHub and Netlify redeploys automatically.

## Step 5 — Set up your first agent (this is how money enters the system)

1. Ask the agent to create a normal account in the app.
2. In your **Admin → Users** tab, find them → tap **Make agent**.
3. Tap **Top up float** and give them a starting float (e.g. D 10,000).
   In real life, float top-up = the agent has paid you that cash/bank transfer first.

## How the money flows (so you can explain it to the client)

- **Cash in:** customer hands cash to agent → agent taps Cash in → customer's wallet goes up, agent's float goes down. Agent earns 1%.
- **Send:** customer sends wallet money to any other Safe number. Free.
- **Cash out:** customer creates a 6-digit code (lasts 30 min) → shows it to any agent → agent redeems it → agent's float goes up → agent hands over the cash. Agent earns 1%.
- **Pay at shop:** admin makes a user a merchant (**Users → Make shop**, enter the shop name) → the shop gets a 6-digit code + a QR. Customer scans the QR with their phone camera (it opens the app with the shop pre-filled) or types the code, enters the amount, confirms with their PIN → money moves instantly to the shop's balance. No fee.
- **No money is ever created** except by admin float top-ups — so the system total always balances.

## Merchant setup (tell your shops this)

1. The shop owner creates a normal Safe account.
2. Admin → Users → find them → **Make shop** → type the business name.
3. The shop logs in and sees the **My shop** tab: their QR, their 6-digit code, and today's sales.
4. Print the QR (screenshot it) and stick it on the counter — done.

## Safety already built in

- PINs are hashed (scrypt + salt) — the real PIN is never stored.
- Every balance change is ONE atomic SQL statement — a transfer can never half-complete.
- Balances can never go negative (database rule, not just app code).
- Login sessions are signed tokens that expire after 12 hours.
- Frozen accounts can't log in, send, or receive.
- **PIN re-entry** is required on every send and shop payment — a stolen unlocked phone still can't move money.
- **Login lockout:** 5 wrong PINs locks the account for 15 minutes (stops PIN guessing).
- **D 50,000 cap per transaction** — limits damage if anything ever goes wrong.
- Atomic transfers now pre-verify the receiver inside the same statement — money can never leave one account without arriving in the other.

## ⚠️ Before real money goes live

This is a complete working system, but running a real money service in The Gambia needs a **Central Bank of The Gambia** licence (payment service provider / mobile money rules) plus KYC (ID checks). Make sure your client handles that side before launch. For a pilot/demo with the client, you're good to go as-is.

## Want to change things later?

- Commission rate: in `api.js`, change `COMMISSION_BPS = 100` (100 = 1%, 50 = 0.5%, 200 = 2%).
- Code expiry: in `api.js`, search for `30 minutes`.
- Transaction cap: in `api.js`, change `MAX_TX`.
- Lockout strictness: in `api.js`, change `LOCK_AFTER` and `LOCK_MINUTES`.
- Colours: in `index.html`, everything is at the top under `:root` — `--leaf` is your light green.
- App name: search-and-replace "Safe" in `index.html`.
