const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/auth');
const { generateNextDays, parseDate, TIME_SLOTS } = require('../utils/slots');
const { normalizePhone, isValidPhone } = require('../utils/validate');

const router = express.Router();
router.use(requireAuth);

// ---------- Appointments ----------

// GET /api/admin/appointments?status=&date=&dateFrom=&dateTo=&mode=&search=
// dateFrom/dateTo (inclusive) let the dashboard filter by day, week, or month;
// search matches patient name or phone (partial match, case-insensitive).
router.get('/appointments', async (req, res, next) => {
  try {
    const { status, date, dateFrom, dateTo, mode, search } = req.query;
    let sql = 'SELECT * FROM appointments WHERE 1=1';
    const params = [];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (date) { sql += ' AND appointment_date = ?'; params.push(date); }
    if (dateFrom) { sql += ' AND appointment_date >= ?'; params.push(dateFrom); }
    if (dateTo) { sql += ' AND appointment_date <= ?'; params.push(dateTo); }
    if (mode) { sql += ' AND mode = ?'; params.push(mode); }
    if (search && search.trim()) {
      sql += ' AND (patient_name LIKE ? OR patient_phone LIKE ?)';
      const like = `%${search.trim()}%`;
      params.push(like, like);
    }

    sql += ' ORDER BY appointment_date ASC, time_slot ASC';
    const appointments = await db.all(sql, ...params);
    res.json({ appointments });
  } catch (err) { next(err); }
});

// PATCH /api/admin/appointments/:id
// Accepts any of: status, notes, patientName, patientPhone, date, timeSlot (reschedule).
// Changing date/timeSlot is checked against other patients' bookings (but not
// against doctor-closed days/slots — the doctor can still hand-place a booking
// there if needed).
router.patch('/appointments/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, notes, patientName, patientPhone, date, timeSlot } = req.body || {};

    const existing = await db.get('SELECT * FROM appointments WHERE id = ?', id);
    if (!existing) return res.status(404).json({ error: 'Appointment not found.' });

    if (status && !['booked', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    let newDate = existing.appointment_date;
    let newTimeSlot = existing.time_slot;
    let newDayName = existing.day_name;
    if (date !== undefined || timeSlot !== undefined) {
      const targetDate = date !== undefined ? date : existing.appointment_date;
      const targetSlot = timeSlot !== undefined ? timeSlot : existing.time_slot;
      const parsed = parseDate(targetDate);
      if (!parsed) return res.status(400).json({ error: 'That date is not valid.' });
      if (!TIME_SLOTS.includes(targetSlot)) return res.status(400).json({ error: 'That time slot is not valid.' });

      if (targetDate !== existing.appointment_date || targetSlot !== existing.time_slot) {
        const conflict = await db.get(
          `SELECT id FROM appointments WHERE appointment_date = ? AND time_slot = ? AND status = 'booked' AND id != ?`,
          targetDate,
          targetSlot,
          id
        );
        if (conflict) {
          return res.status(409).json({ error: 'That slot is already booked by another patient.' });
        }
        // Clear any patient-side hold sitting on the new slot so it doesn't collide later.
        await db.run('DELETE FROM slot_holds WHERE date = ? AND time_slot = ?', targetDate, targetSlot);
      }
      newDate = targetDate;
      newTimeSlot = targetSlot;
      newDayName = parsed.dayName;
    }

    let newPhone = existing.patient_phone;
    if (patientPhone !== undefined) {
      if (!isValidPhone(patientPhone)) {
        return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.', code: 'INVALID_PHONE' });
      }
      newPhone = normalizePhone(patientPhone);
    }
    const newName = patientName !== undefined && patientName.trim() ? patientName.trim() : existing.patient_name;

    await db.run(
      `UPDATE appointments
       SET status = COALESCE(?, status), notes = COALESCE(?, notes),
           patient_name = ?, patient_phone = ?, appointment_date = ?, time_slot = ?, day_name = ?
       WHERE id = ?`,
      status || null,
      notes ?? null,
      newName,
      newPhone,
      newDate,
      newTimeSlot,
      newDayName,
      id
    );

    const updated = await db.get('SELECT * FROM appointments WHERE id = ?', id);
    res.json({ appointment: updated });
  } catch (err) { next(err); }
});

// ---------- Requests (online appointment / query) ----------

router.get('/requests', async (req, res, next) => {
  try {
    const { status, type, search } = req.query;
    let sql = 'SELECT * FROM requests WHERE 1=1';
    const params = [];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (search && search.trim()) {
      sql += ' AND (patient_name LIKE ? OR patient_phone LIKE ?)';
      const like = `%${search.trim()}%`;
      params.push(like, like);
    }

    sql += ' ORDER BY created_at DESC';
    const requests = await db.all(sql, ...params);
    res.json({ requests });
  } catch (err) { next(err); }
});

router.patch('/requests/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body || {};

    const existing = await db.get('SELECT * FROM requests WHERE id = ?', id);
    if (!existing) return res.status(404).json({ error: 'Request not found.' });

    if (status && !['open', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    await db.run('UPDATE requests SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?', status || null, notes ?? null, id);

    const updated = await db.get('SELECT * FROM requests WHERE id = ?', id);
    res.json({ request: updated });
  } catch (err) { next(err); }
});

// ---------- Schedule: close/reopen whole days ----------

// GET /api/admin/schedule/days?upcomingOnly=1 -> the next 30 calendar days with closed flag,
// so the admin UI can render a picker without needing to guess dates.
router.get('/schedule/days', async (req, res, next) => {
  try {
    const days = generateNextDays(30);
    const closedRows = await db.all('SELECT date, reason FROM closed_days');
    const closedMap = new Map(closedRows.map((r) => [r.date, r.reason]));
    const result = days.map((d) => ({ ...d, closed: closedMap.has(d.date), reason: closedMap.get(d.date) || '' }));
    res.json({ days: result });
  } catch (err) { next(err); }
});

// GET /api/admin/schedule/closed-days -> just the ones currently closed (any date, past or future)
router.get('/schedule/closed-days', async (req, res, next) => {
  try {
    const closedDays = await db.all('SELECT * FROM closed_days ORDER BY date ASC');
    res.json({ closedDays });
  } catch (err) { next(err); }
});

// POST /api/admin/schedule/close-day  { date, reason }
router.post('/schedule/close-day', async (req, res, next) => {
  try {
    const { date, reason } = req.body || {};
    const parsed = parseDate(date);
    if (!parsed) return res.status(400).json({ error: 'A valid date is required.' });

    try {
      await db.run('INSERT INTO closed_days (date, reason) VALUES (?, ?)', date, reason || '');
    } catch (e) {
      return res.status(409).json({ error: 'That day is already closed.' });
    }
    // A patient mid-booking on this day shouldn't be able to slip a booking through.
    await db.run('DELETE FROM slot_holds WHERE date = ?', date);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/schedule/close-day/:date -> reopen a day
router.delete('/schedule/close-day/:date', async (req, res, next) => {
  try {
    await db.run('DELETE FROM closed_days WHERE date = ?', req.params.date);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- Schedule: close/reopen individual slots ----------

// GET /api/admin/schedule/slots?date=YYYY-MM-DD -> all slot times with closed + booked + held flags
router.get('/schedule/slots', async (req, res, next) => {
  try {
    const { date } = req.query;
    const parsed = parseDate(date);
    if (!parsed) return res.status(400).json({ error: 'A valid date is required.' });

    const closedRows = await db.all('SELECT time_slot, reason FROM closed_slots WHERE date = ?', date);
    const closedMap = new Map(closedRows.map((r) => [r.time_slot, r.reason]));
    const bookedRows = await db.all(`SELECT time_slot FROM appointments WHERE appointment_date = ? AND status = 'booked'`, date);
    const booked = bookedRows.map((r) => r.time_slot);
    const heldRows = await db.all(`SELECT time_slot FROM slot_holds WHERE date = ? AND expires_at > datetime('now')`, date);
    const held = heldRows.map((r) => r.time_slot);

    const slots = TIME_SLOTS.map((t) => ({
      time: t,
      closed: closedMap.has(t),
      reason: closedMap.get(t) || '',
      booked: booked.includes(t),
      held: held.includes(t),
    }));
    res.json({ date, dayName: parsed.dayName, slots });
  } catch (err) { next(err); }
});

// POST /api/admin/schedule/close-slot  { date, timeSlot, reason }
router.post('/schedule/close-slot', async (req, res, next) => {
  try {
    const { date, timeSlot, reason } = req.body || {};
    const parsed = parseDate(date);
    if (!parsed || !TIME_SLOTS.includes(timeSlot)) {
      return res.status(400).json({ error: 'A valid date and time slot are required.' });
    }
    try {
      await db.run('INSERT INTO closed_slots (date, time_slot, reason) VALUES (?, ?, ?)', date, timeSlot, reason || '');
    } catch (e) {
      return res.status(409).json({ error: 'That slot is already closed.' });
    }
    await db.run('DELETE FROM slot_holds WHERE date = ? AND time_slot = ?', date, timeSlot);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/schedule/close-slot  { date, timeSlot }  (body, since both parts are needed)
router.delete('/schedule/close-slot', async (req, res, next) => {
  try {
    const { date, timeSlot } = req.body || {};
    await db.run('DELETE FROM closed_slots WHERE date = ? AND time_slot = ?', date, timeSlot);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- Medicines (inventory) ----------

router.get('/medicines', async (req, res, next) => {
  try {
    const medicines = await db.all('SELECT * FROM medicines ORDER BY name ASC');
    res.json({ medicines });
  } catch (err) { next(err); }
});

router.post('/medicines', async (req, res, next) => {
  try {
    const { name, qty, unit, price } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Medicine name is required.' });
    const qtyNum = Number(qty);
    if (!Number.isInteger(qtyNum) || qtyNum < 0) {
      return res.status(400).json({ error: 'Quantity must be a whole number of 0 or more.' });
    }

    try {
      const info = await db.run('INSERT INTO medicines (name, qty, unit, price) VALUES (?, ?, ?, ?)', name.trim(), qtyNum, (unit || '').trim(), (price || '').trim());
      const medicine = await db.get('SELECT * FROM medicines WHERE id = ?', info.lastInsertRowid);
      res.status(201).json({ medicine });
    } catch (e) {
      res.status(409).json({ error: 'A medicine with that name already exists.' });
    }
  } catch (err) { next(err); }
});

// PATCH /api/admin/medicines/:id  { name?, qty?, unit?, price? }  -- used for edits and restocking
router.patch('/medicines/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, qty, unit, price } = req.body || {};

    const existing = await db.get('SELECT * FROM medicines WHERE id = ?', id);
    if (!existing) return res.status(404).json({ error: 'Medicine not found.' });

    let qtyNum = existing.qty;
    if (qty !== undefined) {
      qtyNum = Number(qty);
      if (!Number.isInteger(qtyNum) || qtyNum < 0) {
        return res.status(400).json({ error: 'Quantity must be a whole number of 0 or more.' });
      }
    }

    await db.run(
      `UPDATE medicines SET name = COALESCE(?, name), qty = ?, unit = COALESCE(?, unit), price = COALESCE(?, price), updated_at = datetime('now') WHERE id = ?`,
      name ? name.trim() : null,
      qtyNum,
      unit !== undefined ? unit.trim() : null,
      price !== undefined ? price.trim() : null,
      id
    );

    const updated = await db.get('SELECT * FROM medicines WHERE id = ?', id);
    res.json({ medicine: updated });
  } catch (err) { next(err); }
});

router.delete('/medicines/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    // Past orders keep their medicine_name for history, but the FK link is cleared
    // so the medicine row itself can be removed from inventory.
    await db.run('UPDATE medicine_orders SET medicine_id = NULL WHERE medicine_id = ?', id);
    await db.run('DELETE FROM medicines WHERE id = ?', id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- Medicine orders ----------

router.get('/medicine-orders', async (req, res, next) => {
  try {
    const { status, search } = req.query;
    let sql = 'SELECT * FROM medicine_orders WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (search && search.trim()) {
      sql += ' AND (patient_name LIKE ? OR patient_phone LIKE ?)';
      const like = `%${search.trim()}%`;
      params.push(like, like);
    }
    sql += ' ORDER BY created_at DESC';
    const orders = await db.all(sql, ...params);
    res.json({ orders });
  } catch (err) { next(err); }
});

// PATCH /api/admin/medicine-orders/:id  { status: 'accepted' | 'rejected', notes }
// Accepting deducts stock; you can't accept if there isn't enough left (restock first).
router.patch('/medicine-orders/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body || {};

    const order = await db.get('SELECT * FROM medicine_orders WHERE id = ?', id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `This order was already ${order.status}.` });
    }
    if (!['accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    if (status === 'accepted') {
      const medicine = order.medicine_id ? await db.get('SELECT * FROM medicines WHERE id = ?', order.medicine_id) : null;
      if (!medicine) {
        return res.status(409).json({ error: 'This medicine no longer exists in inventory.' });
      }
      if (medicine.qty < order.quantity) {
        return res.status(409).json({ error: `Not enough stock (have ${medicine.qty}, need ${order.quantity}). Restock first.` });
      }
      await db.run(`UPDATE medicines SET qty = qty - ?, updated_at = datetime('now') WHERE id = ?`, order.quantity, medicine.id);
    }

    await db.run('UPDATE medicine_orders SET status = ?, notes = COALESCE(?, notes) WHERE id = ?', status, notes ?? null, id);

    const updated = await db.get('SELECT * FROM medicine_orders WHERE id = ?', id);
    res.json({ order: updated });
  } catch (err) { next(err); }
});

// ---------- Dashboard stats ----------

router.get('/stats', async (req, res, next) => {
  try {
    const today = new Date();
    const iso = today.toISOString().slice(0, 10);

    const todayRow = await db.get(`SELECT COUNT(*) AS c FROM appointments WHERE appointment_date = ? AND status = 'booked'`, iso);
    const upcomingRow = await db.get(`SELECT COUNT(*) AS c FROM appointments WHERE appointment_date >= ? AND status = 'booked'`, iso);
    const openRow = await db.get(`SELECT COUNT(*) AS c FROM requests WHERE status = 'open'`);
    const completedRow = await db.get(`SELECT COUNT(*) AS c FROM appointments WHERE status = 'completed'`);
    const pendingRow = await db.get(`SELECT COUNT(*) AS c FROM medicine_orders WHERE status = 'pending'`);
    const lowStockRow = await db.get(`SELECT COUNT(*) AS c FROM medicines WHERE qty <= 5`);

    res.json({
      todayCount: todayRow.c,
      upcomingCount: upcomingRow.c,
      openRequests: openRow.c,
      completedTotal: completedRow.c,
      pendingMedicineOrders: pendingRow.c,
      lowStockCount: lowStockRow.c,
    });
  } catch (err) { next(err); }
});

module.exports = router;
