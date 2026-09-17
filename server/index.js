const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const db = require('./db');

const authRoutes = require('./routes/auth.routes');
const publicRoutes = require('./routes/public.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();

app.use(cors());
app.use(express.json());

// The database (schema + seed data) is set up lazily and cached — this runs
// once per cold start locally or on Vercel, and is a no-op after that.
app.use(async (req, res, next) => {
  try {
    await db.ready();
    next();
  } catch (err) {
    next(err);
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/admin', adminRoutes);

// Serve the patient chat app and the admin dashboard as static files.
// On Vercel these are actually served directly by the platform (see vercel.json);
// this stays here so `npm start` still works unchanged for local development.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

// Catch-all error handler: return clean JSON instead of an HTML stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

// Only start a listening server for local development / traditional hosting
// (Render, Railway, a VPS, etc). On Vercel, this file is required by
// api/index.js instead, which exports `app` directly as the serverless
// function handler — Vercel calls it per-request rather than binding a port.
if (!process.env.VERCEL) {
  app.listen(config.port, () => {
    console.log('');
    console.log(`${config.clinicName} server running`);
    console.log(`  Patient booking:  http://localhost:${config.port}/`);
    console.log(`  Admin / doctor:   http://localhost:${config.port}/admin`);
    console.log('');
  });
}

module.exports = app;
