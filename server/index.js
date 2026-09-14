const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');

// Initializing db.js also creates tables + seeds the admin login on first run
require('./db');

const authRoutes = require('./routes/auth.routes');
const publicRoutes = require('./routes/public.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/admin', adminRoutes);

// Serve the patient chat app and the admin dashboard as static files
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

// Catch-all error handler: return clean JSON instead of an HTML stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

app.listen(config.port, () => {
  console.log('');
  console.log(`${config.clinicName} server running`);
  console.log(`  Patient booking:  http://localhost:${config.port}/`);
  console.log(`  Admin / doctor:   http://localhost:${config.port}/admin`);
  console.log('');
});
