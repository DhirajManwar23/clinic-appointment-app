const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(user.doctor_id);

  const token = jwt.sign(
    { sub: user.id, username: user.username, doctorId: user.doctor_id },
    config.jwtSecret,
    { expiresIn: '12h' }
  );

  res.json({
    token,
    doctor: doctor ? { name: doctor.name, clinicName: doctor.clinic_name } : null,
  });
});

module.exports = router;
