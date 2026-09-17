const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const user = await db.get('SELECT * FROM admin_users WHERE username = ?', username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Incorrect username or password.' });
    }

    const doctor = await db.get('SELECT * FROM doctors WHERE id = ?', user.doctor_id);

    const token = jwt.sign(
      { sub: user.id, username: user.username, doctorId: user.doctor_id },
      config.jwtSecret,
      { expiresIn: '12h' }
    );

    res.json({
      token,
      doctor: doctor ? { name: doctor.name, clinicName: doctor.clinic_name } : null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
