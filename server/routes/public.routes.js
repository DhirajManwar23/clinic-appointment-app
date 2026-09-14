const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const { generateNextDays, parseDate, TIME_SLOTS } = require('../utils/slots');

const router = express.Router();
const PHONE_RE = /^[0-9+\-\s]{7,15}$/;
const HOLD_MINUTES = 5;

// GET /api/public/days -> upcoming bookable days (closed days removed)
router.get('/days', (req, res) => {
  const closed = db.prepare('SELECT date FROM closed_days').all().map((r) => r.date);
  const days = generateNextDays(14).filter((d) => !closed.includes(d.date));
  res.json({ days });
});

// GET /api/public/slots?date=YYYY-MM-DD&excludeHoldToken=... -> slots with `booked`/`held` flags
// (slots the doctor has closed are left out entirely; a caller's own active hold,
// identified by excludeHoldToken, is never shown as unavailable to them)
router.get('/slots', (req, res) => {
  const { date, excludeHoldToken } = req.query;
  const parsed = parseDate(date);
  if (!parsed) return res.status(400).json({ error: 'A valid date is required.' });

  const dayClosed = db.prepare('SELECT 1 FROM closed_days WHERE date = ?').get(date);
  if (dayClosed) {
    return res.status(400).json({ error: 'The clinic is closed on that day.' });
  }

  const closedSlots = db
    .prepare('SELECT time_slot FROM closed_slots WHERE date = ?')
    .all(date)
    .map((r) => r.time_slot);

  const booked = db
    .prepare(`SELECT time_slot FROM appointments WHERE appointment_date = ? AND status = 'booked'`)
    .all(date)
    .map((r) => r.time_slot);

  const heldRows = db
    .prepare(`SELECT time_slot FROM slot_holds WHERE date = ? AND expires_at > datetime('now') AND hold_token != ?`)
    .all(date, excludeHoldToken || '');
  const held = heldRows.map((r) => r.time_slot);

  const slots = TIME_SLOTS.filter((t) => !closedSlots.includes(t)).map((t) => ({
    time: t,
    booked: booked.includes(t),
    held: held.includes(t),
  }));

  res.json({ date, dayName: parsed.dayName, slots });
});

// POST /api/public/slots/hold -> reserve a slot for HOLD_MINUTES just for this caller
router.post('/slots/hold', (req, res) => {
  const { date, timeSlot } = req.body || {};
  const parsed = parseDate(date);
  if (!parsed || !TIME_SLOTS.includes(timeSlot)) {
    return res.status(400).json({ error: 'A valid date and time slot are required.' });
  }

  const dayClosed = db.prepare('SELECT 1 FROM closed_days WHERE date = ?').get(date);
  if (dayClosed) return res.status(400).json({ error: 'The clinic is closed on that day.' });

  const slotClosed = db.prepare('SELECT 1 FROM closed_slots WHERE date = ? AND time_slot = ?').get(date, timeSlot);
  if (slotClosed) return res.status(400).json({ error: 'That time slot is not available.' });

  const alreadyBooked = db
    .prepare(`SELECT id FROM appointments WHERE appointment_date = ? AND time_slot = ? AND status = 'booked'`)
    .get(date, timeSlot);
  if (alreadyBooked) {
    return res.status(409).json({ error: 'Sorry, that slot was just booked by someone else. Please pick another.', code: 'SLOT_UNAVAILABLE' });
  }

  // clear out anyone else's expired hold on this slot before checking
  db.prepare(`DELETE FROM slot_holds WHERE date = ? AND time_slot = ? AND expires_at <= datetime('now')`).run(date, timeSlot);

  const activeHold = db.prepare('SELECT id FROM slot_holds WHERE date = ? AND time_slot = ?').get(date, timeSlot);
  if (activeHold) {
    return res.status(409).json({ error: 'Someone else is currently booking that slot. Please pick another or try again shortly.', code: 'SLOT_UNAVAILABLE' });
  }

  const holdToken = crypto.randomUUID();
  db.prepare(
    `INSERT INTO slot_holds (date, time_slot, hold_token, expires_at) VALUES (?, ?, ?, datetime('now', '+${HOLD_MINUTES} minutes'))`
  ).run(date, timeSlot, holdToken);

  res.status(201).json({ holdToken, expiresInSeconds: HOLD_MINUTES * 60 });
});

// DELETE /api/public/slots/hold -> release a hold early (e.g. patient restarts booking)
router.delete('/slots/hold', (req, res) => {
  const { date, timeSlot, holdToken } = req.body || {};
  if (date && timeSlot && holdToken) {
    db.prepare('DELETE FROM slot_holds WHERE date = ? AND time_slot = ? AND hold_token = ?').run(date, timeSlot, holdToken);
  }
  res.json({ ok: true });
});

// POST /api/public/appointments -> book an offline appointment
router.post('/appointments', (req, res) => {
  const { patientName, patientPhone, language, date, timeSlot, holdToken } = req.body || {};

  if (!patientName || !patientPhone || !date || !timeSlot) {
    return res.status(400).json({ error: 'Name, phone, date and time slot are all required.' });
  }
  if (!PHONE_RE.test(patientPhone)) {
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  }

  const parsed = parseDate(date);
  if (!parsed) return res.status(400).json({ error: 'That date is not valid.' });

  const dayClosed = db.prepare('SELECT 1 FROM closed_days WHERE date = ?').get(date);
  if (dayClosed) return res.status(400).json({ error: 'The clinic is closed on that day.' });

  if (!TIME_SLOTS.includes(timeSlot)) {
    return res.status(400).json({ error: 'That time slot is not valid.' });
  }

  const slotClosed = db
    .prepare('SELECT 1 FROM closed_slots WHERE date = ? AND time_slot = ?')
    .get(date, timeSlot);
  if (slotClosed) return res.status(400).json({ error: 'That time slot is not available.' });

  const alreadyBooked = db
    .prepare(`SELECT id FROM appointments WHERE appointment_date = ? AND time_slot = ? AND status = 'booked'`)
    .get(date, timeSlot);
  if (alreadyBooked) {
    return res.status(409).json({ error: 'Sorry, that slot was just booked by someone else. Please pick another.', code: 'SLOT_UNAVAILABLE' });
  }

  // If someone else currently holds this slot, only they can complete the booking.
  const activeHold = db
    .prepare(`SELECT hold_token FROM slot_holds WHERE date = ? AND time_slot = ? AND expires_at > datetime('now')`)
    .get(date, timeSlot);
  if (activeHold && activeHold.hold_token !== holdToken) {
    return res.status(409).json({ error: 'Sorry, that slot is reserved by someone else right now. Please pick another.', code: 'SLOT_UNAVAILABLE' });
  }

  const info = db
    .prepare(
      `INSERT INTO appointments (patient_name, patient_phone, language, day_name, appointment_date, time_slot, status)
       VALUES (?, ?, ?, ?, ?, ?, 'booked')`
    )
    .run(patientName.trim(), patientPhone.trim(), language || 'en', parsed.dayName, date, timeSlot);

  // The slot is booked now, so any hold on it (ours or a stray one) is no longer needed.
  db.prepare('DELETE FROM slot_holds WHERE date = ? AND time_slot = ?').run(date, timeSlot);

  const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ appointment });
});

// POST /api/public/requests -> online appointment / query requests
router.post('/requests', (req, res) => {
  const { patientName, patientPhone, language, type, message } = req.body || {};

  if (!patientName || !patientPhone || !type) {
    return res.status(400).json({ error: 'Name, phone and request type are required.' });
  }
  if (!['online', 'query'].includes(type)) {
    return res.status(400).json({ error: 'Unknown request type.' });
  }
  if (!PHONE_RE.test(patientPhone)) {
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  }

  const info = db
    .prepare(
      `INSERT INTO requests (patient_name, patient_phone, language, type, message, status)
       VALUES (?, ?, ?, ?, ?, 'open')`
    )
    .run(patientName.trim(), patientPhone.trim(), language || 'en', type, (message || '').trim());

  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ request });
});

// ---------- Medicines ----------

// GET /api/public/medicines -> everything in the doctor's inventory (patients can see qty = 0 too, shown as out of stock)
router.get('/medicines', (req, res) => {
  const medicines = db.prepare('SELECT id, name, qty, unit, price FROM medicines ORDER BY name ASC').all();
  res.json({ medicines });
});

// POST /api/public/medicine-orders -> patient requests to buy a medicine
router.post('/medicine-orders', (req, res) => {
  const { patientName, patientPhone, language, medicineId, quantity } = req.body || {};

  if (!patientName || !patientPhone || !medicineId || !quantity) {
    return res.status(400).json({ error: 'Name, phone, medicine and quantity are required.' });
  }
  if (!PHONE_RE.test(patientPhone)) {
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  }
  const qtyNum = Number(quantity);
  if (!Number.isInteger(qtyNum) || qtyNum < 1) {
    return res.status(400).json({ error: 'Please enter a valid quantity.' });
  }

  const medicine = db.prepare('SELECT * FROM medicines WHERE id = ?').get(medicineId);
  if (!medicine) return res.status(404).json({ error: 'That medicine could not be found.' });

  const info = db
    .prepare(
      `INSERT INTO medicine_orders (patient_name, patient_phone, language, medicine_id, medicine_name, quantity, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(patientName.trim(), patientPhone.trim(), language || 'en', medicine.id, medicine.name, qtyNum);

  const order = db.prepare('SELECT * FROM medicine_orders WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ order });
});

module.exports = router;
