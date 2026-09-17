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

## 3. Deploying it for real use

To make this reachable outside your own computer, deploy it to any Node-friendly
host (Render, Railway, a VPS, etc.):

1. Push this folder to a git repo (or upload it).
2. Set the same environment variables from `.env` in the host's dashboard.
3. Start command: `npm start`.
4. Point your domain at it, and consider adding HTTPS (most hosts do this for you).

The SQLite file works fine for a single clinic. If you later need multiple
locations or heavier traffic, the schema in `server/db.js` can be swapped for
Postgres/MySQL with only the `db.js` file needing changes — the routes stay
the same.

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
  server/
    index.js              # Express app entry point
    config.js              # reads .env
    db.js                   # SQLite schema + seeds the admin login
    utils/slots.js          # working days / time slots / date helpers
    middleware/auth.js      # JWT auth guard for admin routes
    routes/
      auth.routes.js        # POST /api/auth/login
      public.routes.js      # GET days/slots, POST appointments/requests
      admin.routes.js       # protected: list/cancel/complete/close, stats
  public/
    index.html               # patient chat booking app
    admin/index.html          # doctor/admin dashboard (login + tables)
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
