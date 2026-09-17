const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const { generateNextDays, parseDate, TIME_SLOTS } = require('../utils/slots');
const { normalizePhone, isValidPhone } = require('../utils/validate');

const router = express.Router();
const HOLD_MINUTES = 5;

// GET /api/public/days -> upcoming bookable days (closed days removed)
router.get('/days', async (req, res, next) => {
  try {
    const closedRows = await db.all('SELECT date FROM closed_days');
    const closed = closedRows.map((r) => r.date);
    const days = generateNextDays(14).filter((d) => !closed.includes(d.date));
    res.json({ days });
  } catch (err) { next(err); }
});

// GET /api/public/slots?date=YYYY-MM-DD&excludeHoldToken=... -> slots with `booked`/`held` flags
// (slots the doctor has closed are left out entirely; a caller's own active hold,
// identified by excludeHoldToken, is never shown as unavailable to them)
router.get('/slots', async (req, res, next) => {
  try {
    const { date, excludeHoldToken } = req.query;
    const parsed = parseDate(date);
    if (!parsed) return res.status(400).json({ error: 'A valid date is required.' });

    const dayClosed = await db.get('SELECT 1 FROM closed_days WHERE date = ?', date);
    if (dayClosed) {
      return res.status(400).json({ error: 'The clinic is closed on that day.' });
    }

    const closedSlotRows = await db.all('SELECT time_slot FROM closed_slots WHERE date = ?', date);
    const closedSlots = closedSlotRows.map((r) => r.time_slot);

    const bookedRows = await db.all(`SELECT time_slot FROM appointments WHERE appointment_date = ? AND status = 'booked'`, date);
    const booked = bookedRows.map((r) => r.time_slot);

    const heldRows = await db.all(
      `SELECT time_slot FROM slot_holds WHERE date = ? AND expires_at > datetime('now') AND hold_token != ?`,
      date,
      excludeHoldToken || ''
    );
    const held = heldRows.map((r) => r.time_slot);

    const slots = TIME_SLOTS.filter((t) => !closedSlots.includes(t)).map((t) => ({
      time: t,
      booked: booked.includes(t),
      held: held.includes(t),
    }));

    res.json({ date, dayName: parsed.dayName, slots });
  } catch (err) { next(err); }
});

// POST /api/public/slots/hold -> reserve a slot for HOLD_MINUTES just for this caller
router.post('/slots/hold', async (req, res, next) => {
  try {
    const { date, timeSlot } = req.body || {};
    const parsed = parseDate(date);
    if (!parsed || !TIME_SLOTS.includes(timeSlot)) {
      return res.status(400).json({ error: 'A valid date and time slot are required.' });
    }

    const dayClosed = await db.get('SELECT 1 FROM closed_days WHERE date = ?', date);
    if (dayClosed) return res.status(400).json({ error: 'The clinic is closed on that day.' });

    const slotClosed = await db.get('SELECT 1 FROM closed_slots WHERE date = ? AND time_slot = ?', date, timeSlot);
    if (slotClosed) return res.status(400).json({ error: 'That time slot is not available.' });

    const alreadyBooked = await db.get(
      `SELECT id FROM appointments WHERE appointment_date = ? AND time_slot = ? AND status = 'booked'`,
      date,
      timeSlot
    );
    if (alreadyBooked) {
      return res.status(409).json({ error: 'Sorry, that slot was just booked by someone else. Please pick another.', code: 'SLOT_UNAVAILABLE' });
    }

    // clear out anyone else's expired hold on this slot before checking
    await db.run(`DELETE FROM slot_holds WHERE date = ? AND time_slot = ? AND expires_at <= datetime('now')`, date, timeSlot);

    const activeHold = await db.get('SELECT id FROM slot_holds WHERE date = ? AND time_slot = ?', date, timeSlot);
    if (activeHold) {
      return res.status(409).json({ error: 'Someone else is currently booking that slot. Please pick another or try again shortly.', code: 'SLOT_UNAVAILABLE' });
    }

    const holdToken = crypto.randomUUID();
    await db.run(
      `INSERT INTO slot_holds (date, time_slot, hold_token, expires_at) VALUES (?, ?, ?, datetime('now', '+${HOLD_MINUTES} minutes'))`,
      date,
      timeSlot,
      holdToken
    );

    res.status(201).json({ holdToken, expiresInSeconds: HOLD_MINUTES * 60 });
  } catch (err) { next(err); }
});

// DELETE /api/public/slots/hold -> release a hold early (e.g. patient restarts booking)
router.delete('/slots/hold', async (req, res, next) => {
  try {
    const { date, timeSlot, holdToken } = req.body || {};
    if (date && timeSlot && holdToken) {
      await db.run('DELETE FROM slot_holds WHERE date = ? AND time_slot = ? AND hold_token = ?', date, timeSlot, holdToken);
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/public/appointments -> book an offline appointment
router.post('/appointments', async (req, res, next) => {
  try {
    const { patientName, patientPhone, language, date, timeSlot, holdToken, mode, notes } = req.body || {};

    if (!patientName || !patientPhone || !date || !timeSlot) {
      return res.status(400).json({ error: 'Name, phone, date and time slot are all required.' });
    }
    if (!isValidPhone(patientPhone)) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.', code: 'INVALID_PHONE' });
    }
    const cleanPhone = normalizePhone(patientPhone);
    const appointmentMode = mode === 'online' ? 'online' : 'offline';

    const parsed = parseDate(date);
    if (!parsed) return res.status(400).json({ error: 'That date is not valid.' });

    const dayClosed = await db.get('SELECT 1 FROM closed_days WHERE date = ?', date);
    if (dayClosed) return res.status(400).json({ error: 'The clinic is closed on that day.' });

    if (!TIME_SLOTS.includes(timeSlot)) {
      return res.status(400).json({ error: 'That time slot is not valid.' });
    }

    const slotClosed = await db.get('SELECT 1 FROM closed_slots WHERE date = ? AND time_slot = ?', date, timeSlot);
    if (slotClosed) return res.status(400).json({ error: 'That time slot is not available.' });

    const alreadyBooked = await db.get(
      `SELECT id FROM appointments WHERE appointment_date = ? AND time_slot = ? AND status = 'booked'`,
      date,
      timeSlot
    );
    if (alreadyBooked) {
      return res.status(409).json({ error: 'Sorry, that slot was just booked by someone else. Please pick another.', code: 'SLOT_UNAVAILABLE' });
    }

    // If someone else currently holds this slot, only they can complete the booking.
    const activeHold = await db.get(
      `SELECT hold_token FROM slot_holds WHERE date = ? AND time_slot = ? AND expires_at > datetime('now')`,
      date,
      timeSlot
    );
    if (activeHold && activeHold.hold_token !== holdToken) {
      return res.status(409).json({ error: 'Sorry, that slot is reserved by someone else right now. Please pick another.', code: 'SLOT_UNAVAILABLE' });
    }

    const info = await db.run(
      `INSERT INTO appointments (patient_name, patient_phone, language, day_name, appointment_date, time_slot, mode, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'booked', ?)`,
      patientName.trim(),
      cleanPhone,
      language || 'en',
      parsed.dayName,
      date,
      timeSlot,
      appointmentMode,
      (notes || '').trim()
    );

    // The slot is booked now, so any hold on it (ours or a stray one) is no longer needed.
    await db.run('DELETE FROM slot_holds WHERE date = ? AND time_slot = ?', date, timeSlot);

    const appointment = await db.get('SELECT * FROM appointments WHERE id = ?', info.lastInsertRowid);
    res.status(201).json({ appointment });
  } catch (err) { next(err); }
});

// POST /api/public/requests -> general query requests
router.post('/requests', async (req, res, next) => {
  try {
    const { patientName, patientPhone, language, type, message } = req.body || {};

    if (!patientName || !patientPhone || !type) {
      return res.status(400).json({ error: 'Name, phone and request type are required.' });
    }
    if (!['query'].includes(type)) {
      return res.status(400).json({ error: 'Unknown request type.' });
    }
    if (!isValidPhone(patientPhone)) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.', code: 'INVALID_PHONE' });
    }

    const info = await db.run(
      `INSERT INTO requests (patient_name, patient_phone, language, type, message, status)
       VALUES (?, ?, ?, ?, ?, 'open')`,
      patientName.trim(),
      normalizePhone(patientPhone),
      language || 'en',
      type,
      (message || '').trim()
    );

    const request = await db.get('SELECT * FROM requests WHERE id = ?', info.lastInsertRowid);
    res.status(201).json({ request });
  } catch (err) { next(err); }
});

// ---------- Medicines ----------

// GET /api/public/medicines -> everything in the doctor's inventory (patients can see qty = 0 too, shown as out of stock)
router.get('/medicines', async (req, res, next) => {
  try {
    const medicines = await db.all('SELECT id, name, qty, unit, price FROM medicines ORDER BY name ASC');
    res.json({ medicines });
  } catch (err) { next(err); }
});

// POST /api/public/medicine-orders -> patient requests to buy a medicine
router.post('/medicine-orders', async (req, res, next) => {
  try {
    const { patientName, patientPhone, language, medicineId, quantity } = req.body || {};

    if (!patientName || !patientPhone || !medicineId || !quantity) {
      return res.status(400).json({ error: 'Name, phone, medicine and quantity are required.' });
    }
    if (!isValidPhone(patientPhone)) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.', code: 'INVALID_PHONE' });
    }
    const qtyNum = Number(quantity);
    if (!Number.isInteger(qtyNum) || qtyNum < 1) {
      return res.status(400).json({ error: 'Please enter a valid quantity.' });
    }

    const medicine = await db.get('SELECT * FROM medicines WHERE id = ?', medicineId);
    if (!medicine) return res.status(404).json({ error: 'That medicine could not be found.' });

    const info = await db.run(
      `INSERT INTO medicine_orders (patient_name, patient_phone, language, medicine_id, medicine_name, quantity, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      patientName.trim(),
      normalizePhone(patientPhone),
      language || 'en',
      medicine.id,
      medicine.name,
      qtyNum
    );

    const order = await db.get('SELECT * FROM medicine_orders WHERE id = ?', info.lastInsertRowid);
    res.status(201).json({ order });
  } catch (err) { next(err); }
});

// ---------- My Bookings (phone-number lookup, no login needed) ----------

// GET /api/public/my-bookings?phone=9876543210 -> currently OPEN items tied to that phone
// number (a completed/cancelled appointment, an accepted/rejected order, or a closed
// query won't show here — this is "what's still active for me", not a full history).
router.get('/my-bookings', async (req, res, next) => {
  try {
    const { phone } = req.query;
    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.', code: 'INVALID_PHONE' });
    }
    const cleanPhone = normalizePhone(phone);

    const appointments = await db.all(
      `SELECT * FROM appointments WHERE patient_phone = ? AND status = 'booked' ORDER BY appointment_date ASC, time_slot ASC LIMIT 20`,
      cleanPhone
    );
    const medicineOrders = await db.all(
      `SELECT * FROM medicine_orders WHERE patient_phone = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 20`,
      cleanPhone
    );
    const requests = await db.all(
      `SELECT * FROM requests WHERE patient_phone = ? AND status = 'open' ORDER BY created_at DESC LIMIT 20`,
      cleanPhone
    );

    res.json({ appointments, medicineOrders, requests });
  } catch (err) { next(err); }
});

module.exports = router;
