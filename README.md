# OPD Sahayak — Clinic Appointment Web App

A full working web app with two sides:

1. **Patient booking chat** (`/`) — multilingual (Marathi / Hindi / English), lets a
   patient:
   - Book an **Offline Appointment** or an **Online Appointment**: both go through
     the same flow — pick a day → an open time slot → give name & phone (an
     online booking also asks an optional short note for the doctor beforehand).
     Online and offline share the same time slots, since it's the same doctor's
     time either way — booking one blocks the other on that slot.
   - The moment a patient taps a time slot, it's **held for them for 5 minutes**
     — no one else can grab it while they finish entering their details, closing
     the gap between "I picked a time" and "I confirmed it."
   - Browse the **Medicine** list the doctor has stocked and place an order (pick
     medicine → quantity → name & phone).
   - Leave a general **Query** as a free-text request.
   - Check **My Bookings**: enter the phone number used to book, and see every
     appointment, medicine order, and query tied to that number with its current
     status — no login needed, just the phone number.
   - Every phone number entered (booking, ordering, querying, or looking up) is
     validated as a real 10-digit Indian mobile number (starts 6-9); `+91`,
     spaces, and dashes are accepted and cleaned up automatically.
2. **Doctor / Admin dashboard** (`/admin`) — password-protected, with four tabs:
   - **Appointments** — cancel, mark complete, or **edit/reschedule** (change
     name, phone, date, or time slot — checked against other bookings so you
     can't accidentally double-book). Filter by status, mode, a date range
     (day/week/month), or search by patient name/phone.
   - **Requests** — close general query requests once handled.
   - **Schedule** — close an entire day (holiday/leave) or close individual time
     slots on any date; both are instantly hidden from the patient app. Reopen
     either any time.
   - Cancelling an appointment, closing a request, closing a day/slot, or
     accepting/rejecting a medicine order prompts for an optional comment —
     saved as a note and shown with a 📝 icon (hover to read it) next to that
     row afterward.
   - **Medicines** — maintain inventory (add medicines with quantity/unit/price,
     restock, delete) and review incoming **orders**. New orders show a red
     notification count on the tab; accepting an order deducts stock automatically
     (blocked if there isn't enough — restock first), rejecting leaves stock
     untouched. The dashboard polls every 20s so new orders appear without a
     manual refresh.

Real backend: Node.js + Express + SQLite (file-based database, no external DB
server to install). Everything — booking, slot locking so two patients can't grab
the same slot, login, cancel/complete — is enforced on the server, not just in the
browser.

## 1. Install

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
cd clinic-appointment-app
npm install
cp .env.example .env
```

Open `.env` and set your own values, especially:

```
JWT_SECRET=make-this-a-long-random-string
ADMIN_USERNAME=doctor
ADMIN_PASSWORD=pick-a-real-password
DOCTOR_NAME=Dr. Your Name
CLINIC_NAME=Your Clinic Name
```

## 2. Run

```bash
npm start
```

You'll see:

```
OPD Sahayak Clinic server running
  Patient booking:  http://localhost:3000/
  Admin / doctor:   http://localhost:3000/admin
```

- Open **http://localhost:3000/** — this is the patient chat, share this link (or
  QR code to it) with patients / put it on your website.
- Open **http://localhost:3000/admin** — log in with the username/password from
  your `.env` file. This is where the doctor manages appointments.

The database file is created automatically at `data/clinic.db` the first time you
run the app — no separate database setup needed.

## 3. Deploying to Vercel (with Turso as the database)

Vercel runs this app as **serverless functions** — every request can hit a
different, short-lived instance with no shared local disk. That's why the app
now uses [Turso](https://turso.tech) (a hosted, serverless-friendly SQLite)
instead of a local `.db` file in production. Locally, nothing changes — if you
don't set up Turso, the app just uses a local SQLite file exactly as before.

### 3a. Create a free Turso database

1. Install the Turso CLI and sign up (free tier is plenty for one clinic):
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   turso auth signup
   ```
   (Windows: use the [manual install steps](https://docs.turso.tech/cli/installation) or WSL.)
2. Create a database and grab its connection details:
   ```bash
   turso db create opd-sahayak
   turso db show opd-sahayak --url
   turso db tokens create opd-sahayak
   ```
   The first command's output is your `TURSO_DATABASE_URL` (starts with
   `libsql://`); the second is your `TURSO_AUTH_TOKEN`.

### 3b. Deploy to Vercel

1. Push this project to a GitHub/GitLab/Bitbucket repo.
2. Go to [vercel.com](https://vercel.com) → **Add New Project** → import that repo.
   Vercel auto-detects the `vercel.json` in this project — no build settings to change.
3. Before deploying, add these **Environment Variables** in the Vercel project
   settings (Settings → Environment Variables), for **Production** (and
   Preview, if you want preview deployments to work too):

   | Name | Value |
   |---|---|
   | `TURSO_DATABASE_URL` | from `turso db show ... --url` |
   | `TURSO_AUTH_TOKEN` | from `turso db tokens create ...` |
   | `JWT_SECRET` | a long random string |
   | `ADMIN_USERNAME` | your choice |
   | `ADMIN_PASSWORD` | your choice |
   | `DOCTOR_NAME` | e.g. `Dr. Sharma` |
   | `CLINIC_NAME` | e.g. `OPD Sahayak Clinic` |

4. Deploy. Vercel gives you a URL like `https://your-project.vercel.app`:
   - Patient booking: `https://your-project.vercel.app/`
   - Admin dashboard: `https://your-project.vercel.app/admin`

Or from the CLI instead of the dashboard:
```bash
npm install -g vercel
vercel login
vercel link
vercel env add TURSO_DATABASE_URL production
vercel env add TURSO_AUTH_TOKEN production
vercel env add JWT_SECRET production
vercel env add ADMIN_USERNAME production
vercel env add ADMIN_PASSWORD production
vercel env add DOCTOR_NAME production
vercel env add CLINIC_NAME production
vercel --prod
```

### 3c. How the pieces fit together

- `vercel.json` routes `/` and `/admin` to the two HTML files in `public/`,
  and every `/api/*` request to one serverless function (`api/index.js`).
- `api/index.js` just re-exports the same Express app used locally
  (`server/index.js`) — Vercel calls it directly per request instead of it
  listening on a port.
- The very first request after a cold start creates the database tables and
  seeds the admin login automatically (same as running it locally) — nothing
  to do manually on the Turso side.
- Every route already goes through the doctor-closed-day/slot checks and the
  5-minute slot hold, so double-booking protection works the same as before —
  it's now backed by Turso instead of a local file, which is what makes it
  safe across multiple serverless instances running at once.

### 3d. Prefer not to deal with a separate database at all?

If you'd rather not set up Turso, the simplest alternative is a host that
runs a normal, persistent Node process with a local disk — Render, Railway,
or a VPS. There, the app works exactly as it did before this change (falls
back to the local SQLite file automatically when `TURSO_DATABASE_URL` isn't
set):

1. Push this folder to a git repo (or upload it).
2. Set the same environment variables from `.env` in the host's dashboard
   (skip the two `TURSO_*` ones).
3. Start command: `npm start`.
4. Point your domain at it, and consider adding HTTPS (most hosts do this for you).

## 4. Changing the schedule

The clinic is open every day of the week by default, with these slot times
(`server/utils/slots.js`):

```js
const TIME_SLOTS = ['2:45 PM', '3:00 PM', ... '5:30 PM'];
```

Edit this array to change the slot times offered. To close specific **days** or
**slots** (holidays, doctor's leave, lunch breaks, etc.) don't edit code — use the
**Schedule** tab in the admin dashboard instead; those closures are stored in the
database and take effect immediately.

## 5. Project structure

```
clinic-appointment-app/
  api/
    index.js                # Vercel serverless entry point (re-exports server/index.js)
  server/
    index.js              # Express app (exported for both `npm start` and Vercel)
    config.js              # reads .env
    db.js                   # async Turso/libSQL layer — schema + seeds the admin login
    utils/slots.js          # calendar/time-slot helpers
    utils/validate.js       # phone number validation/normalization
    middleware/auth.js      # JWT auth guard for admin routes
    routes/
      auth.routes.js        # POST /api/auth/login
      public.routes.js      # GET days/slots, POST appointments/requests/orders, my-bookings
      admin.routes.js       # protected: appointments/requests/schedule/medicines, stats
  public/
    index.html               # patient chat booking app
    admin/index.html          # doctor/admin dashboard (login + tables)
  vercel.json               # routes / and /admin to static files, /api/* to the function
  .env.example
  package.json
```

## 6. API reference (for reference / integrating your own frontend later)

**Public (no login needed)**
- `GET  /api/public/days` — upcoming bookable days (closed days excluded)
- `GET  /api/public/slots?date=YYYY-MM-DD&excludeHoldToken=` — slots for a day, flagged `booked`/`held` (closed slots excluded entirely; pass your own `excludeHoldToken` so your own hold doesn't show as unavailable to you)
- `POST /api/public/slots/hold` — `{ date, timeSlot }` → `{ holdToken, expiresInSeconds }`, reserves the slot for 5 minutes
- `DELETE /api/public/slots/hold` — body `{ date, timeSlot, holdToken }`, releases a hold early
- `POST /api/public/appointments` — `{ patientName, patientPhone, language, date, timeSlot, holdToken?, mode?: "offline"|"online", notes? }`
- `POST /api/public/requests` — `{ patientName, patientPhone, language, type, message }` (`type`: `query`)
- `GET  /api/public/medicines` — inventory list (name, qty, unit, price)
- `POST /api/public/medicine-orders` — `{ patientName, patientPhone, language, medicineId, quantity }`
- `GET  /api/public/my-bookings?phone=` — appointments, medicine orders, and requests tied to a phone number

**Auth**
- `POST /api/auth/login` — `{ username, password }` → `{ token, doctor }`

**Admin (send `Authorization: Bearer <token>`)**
- `GET   /api/admin/appointments?status=&date=&mode=`
- `PATCH /api/admin/appointments/:id` — `{ status: "completed" | "cancelled" | "booked", notes? }`
- `GET   /api/admin/requests?status=&type=`
- `PATCH /api/admin/requests/:id` — `{ status: "open" | "closed", notes? }`
- `GET    /api/admin/schedule/days` — next 30 days with `closed` flag
- `GET    /api/admin/schedule/closed-days`
- `POST   /api/admin/schedule/close-day` — `{ date, reason? }`
- `DELETE /api/admin/schedule/close-day/:date` — reopen
- `GET    /api/admin/schedule/slots?date=` — slots with `closed` + `booked` flags
- `POST   /api/admin/schedule/close-slot` — `{ date, timeSlot, reason? }`
- `DELETE /api/admin/schedule/close-slot` — body `{ date, timeSlot }` — reopen
- `GET    /api/admin/medicines`
- `POST   /api/admin/medicines` — `{ name, qty, unit?, price? }`
- `PATCH  /api/admin/medicines/:id` — `{ name?, qty?, unit?, price? }` (used for restocking)
- `DELETE /api/admin/medicines/:id`
- `GET    /api/admin/medicine-orders?status=`
- `PATCH  /api/admin/medicine-orders/:id` — `{ status: "accepted" | "rejected" }` (accepting deducts stock)
- `GET   /api/admin/stats`

## Notes / next steps you may want

- **SMS/WhatsApp reminders** are not included — you'd need a provider like Twilio
  or Gupshup and a small script that reads new appointments and sends a message.
- **Multiple doctors**: the database already has a `doctors` table ready for this;
  ask and I can extend the schema + admin panel so patients pick a doctor and each
  doctor only sees their own appointments.
- Passwords are hashed with bcrypt and admin sessions use signed JWTs, but for a
  production deployment also put the app behind HTTPS.
