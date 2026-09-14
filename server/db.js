const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+, no native compile needed
const bcrypt = require('bcryptjs');
const config = require('./config');

// Make sure the folder that will hold the SQLite file exists
const resolvedPath = path.resolve(process.cwd(), config.dbPath);
fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

const database = new DatabaseSync(resolvedPath);
database.exec('PRAGMA journal_mode = WAL;');
database.exec('PRAGMA foreign_keys = ON;');

// Thin wrapper so the rest of the app can keep using db.prepare(...).run/get/all(...)
// exactly like it did with better-sqlite3.
const db = {
  exec: (sql) => database.exec(sql),
  prepare: (sql) => database.prepare(sql),
};

db.exec(`
  CREATE TABLE IF NOT EXISTS doctors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    clinic_name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    doctor_id INTEGER REFERENCES doctors(id)
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_name TEXT NOT NULL,
    patient_phone TEXT NOT NULL,
    language TEXT NOT NULL,
    day_name TEXT NOT NULL,
    appointment_date TEXT NOT NULL,   -- YYYY-MM-DD
    time_slot TEXT NOT NULL,          -- e.g. '2:45 PM'
    status TEXT NOT NULL DEFAULT 'booked', -- booked | completed | cancelled
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_unique
    ON appointments(appointment_date, time_slot)
    WHERE status = 'booked';

  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_name TEXT NOT NULL,
    patient_phone TEXT NOT NULL,
    language TEXT NOT NULL,
    type TEXT NOT NULL,              -- online | query   ('medicine' now goes through medicine_orders instead)
    message TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', -- open | closed
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A whole calendar date the doctor has marked as closed (e.g. holiday, leave).
  CREATE TABLE IF NOT EXISTS closed_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,      -- YYYY-MM-DD
    reason TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A single time slot on a single date the doctor has closed (e.g. away for part of the day).
  CREATE TABLE IF NOT EXISTS closed_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,             -- YYYY-MM-DD
    time_slot TEXT NOT NULL,        -- e.g. '3:00 PM'
    reason TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(date, time_slot)
  );

  -- Medicine inventory the doctor maintains from the admin panel.
  CREATE TABLE IF NOT EXISTS medicines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    qty INTEGER NOT NULL DEFAULT 0,
    unit TEXT DEFAULT '',           -- e.g. 'tablets', 'bottles'
    price TEXT DEFAULT '',          -- free text, e.g. '₹45'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A patient's request to buy/order a medicine. Starts 'pending' until the
  -- doctor accepts (stock is deducted) or rejects it from the admin panel.
  CREATE TABLE IF NOT EXISTS medicine_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_name TEXT NOT NULL,
    patient_phone TEXT NOT NULL,
    language TEXT NOT NULL,
    medicine_id INTEGER REFERENCES medicines(id),
    medicine_name TEXT NOT NULL,    -- captured at order time, kept even if medicine is later deleted
    quantity INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- A short-lived hold on a single slot while one patient is filling in their
  -- name/phone, so a second patient can't grab the same slot in the meantime.
  -- Automatically treated as expired once expires_at passes; the holder proves
  -- ownership with hold_token when they finally submit the booking.
  CREATE TABLE IF NOT EXISTS slot_holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,             -- YYYY-MM-DD
    time_slot TEXT NOT NULL,        -- e.g. '3:00 PM'
    hold_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_slot_holds_lookup ON slot_holds(date, time_slot);
`);

// Seed one doctor row if none exists
let doctor = db.prepare('SELECT * FROM doctors LIMIT 1').get();
if (!doctor) {
  const info = db
    .prepare('INSERT INTO doctors (name, clinic_name) VALUES (?, ?)')
    .run(config.doctorName, config.clinicName);
  doctor = { id: info.lastInsertRowid, name: config.doctorName, clinic_name: config.clinicName };
  console.log(`Seeded doctor: ${config.doctorName} (${config.clinicName})`);
}

// Seed the admin/doctor login if it doesn't already exist
const existingAdmin = db
  .prepare('SELECT * FROM admin_users WHERE username = ?')
  .get(config.adminUsername);

if (!existingAdmin) {
  const hash = bcrypt.hashSync(config.adminPassword, 10);
  db.prepare(
    'INSERT INTO admin_users (username, password_hash, doctor_id) VALUES (?, ?, ?)'
  ).run(config.adminUsername, hash, doctor.id);
  console.log(`Seeded admin login -> username: "${config.adminUsername}"`);
  console.log('   (password comes from ADMIN_PASSWORD in your .env file)');
}

module.exports = db;
