const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const config = require('./config');

// If we're using a local file (no Turso configured), make sure its folder exists.
if (config.tursoUrl.startsWith('file:')) {
  const filePath = config.tursoUrl.slice('file:'.length);
  const resolvedPath = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
}

const client = createClient({
  url: config.tursoUrl,
  authToken: config.tursoAuthToken,
});

// ---- Thin async helpers, shaped to be a near drop-in for the old
// synchronous db.prepare(sql).get/all/run(...args) calls used throughout the
// route files: every call site just gained an `await` and lost `.prepare()`.
async function get(sql, ...args) {
  const res = await client.execute({ sql, args });
  return res.rows[0];
}
async function all(sql, ...args) {
  const res = await client.execute({ sql, args });
  return res.rows;
}
async function run(sql, ...args) {
  const res = await client.execute({ sql, args });
  return { lastInsertRowid: Number(res.lastInsertRowid ?? 0), changes: Number(res.rowsAffected ?? 0) };
}

// ---- Schema + seed data. Safe to call on every cold start: every statement
// is idempotent (IF NOT EXISTS / unique-constraint-guarded inserts).
let readyPromise = null;

async function ensureSchema() {
  await client.batch(
    [
      `CREATE TABLE IF NOT EXISTS doctors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        clinic_name TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        doctor_id INTEGER REFERENCES doctors(id)
      )`,
      `CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_name TEXT NOT NULL,
        patient_phone TEXT NOT NULL,
        language TEXT NOT NULL,
        day_name TEXT NOT NULL,
        appointment_date TEXT NOT NULL,
        time_slot TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'offline',
        status TEXT NOT NULL DEFAULT 'booked',
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_unique
        ON appointments(appointment_date, time_slot)
        WHERE status = 'booked'`,
      `CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_name TEXT NOT NULL,
        patient_phone TEXT NOT NULL,
        language TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS closed_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE NOT NULL,
        reason TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS closed_slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        time_slot TEXT NOT NULL,
        reason TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(date, time_slot)
      )`,
      `CREATE TABLE IF NOT EXISTS medicines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        qty INTEGER NOT NULL DEFAULT 0,
        unit TEXT DEFAULT '',
        price TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS medicine_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_name TEXT NOT NULL,
        patient_phone TEXT NOT NULL,
        language TEXT NOT NULL,
        medicine_id INTEGER REFERENCES medicines(id),
        medicine_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS slot_holds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        time_slot TEXT NOT NULL,
        hold_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_slot_holds_lookup ON slot_holds(date, time_slot)`,
    ],
    'write'
  );

  // Lightweight migration for DBs created before the 'mode' column existed.
  const columns = await all("PRAGMA table_info(appointments)");
  if (!columns.some((c) => c.name === 'mode')) {
    await run("ALTER TABLE appointments ADD COLUMN mode TEXT NOT NULL DEFAULT 'offline'");
    console.log('Migrated appointments table: added "mode" column (offline/online).');
  }

  // Seed one doctor row if none exists.
  let doctor = await get('SELECT * FROM doctors LIMIT 1');
  if (!doctor) {
    const info = await run('INSERT INTO doctors (name, clinic_name) VALUES (?, ?)', config.doctorName, config.clinicName);
    doctor = { id: info.lastInsertRowid, name: config.doctorName, clinic_name: config.clinicName };
    console.log(`Seeded doctor: ${config.doctorName} (${config.clinicName})`);
  }

  // Seed the admin login if it doesn't already exist. The UNIQUE constraint on
  // username means a duplicate insert (e.g. a concurrent cold start racing us)
  // just fails harmlessly, so we swallow that specific case.
  const existingAdmin = await get('SELECT id FROM admin_users WHERE username = ?', config.adminUsername);
  if (!existingAdmin) {
    const hash = bcrypt.hashSync(config.adminPassword, 10);
    try {
      await run(
        'INSERT INTO admin_users (username, password_hash, doctor_id) VALUES (?, ?, ?)',
        config.adminUsername,
        hash,
        doctor.id
      );
      console.log(`Seeded admin login -> username: "${config.adminUsername}"`);
      console.log('   (password comes from ADMIN_PASSWORD)');
    } catch (e) {
      if (!/unique/i.test(e.message || '')) throw e;
    }
  }
}

// Cached across warm serverless invocations; re-run once per cold start.
function ready() {
  if (!readyPromise) readyPromise = ensureSchema();
  return readyPromise;
}

module.exports = { get, all, run, ready, client };
