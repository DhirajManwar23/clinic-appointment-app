require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_change_me',
  adminUsername: process.env.ADMIN_USERNAME || 'doctor',
  adminPassword: process.env.ADMIN_PASSWORD || 'changeme123',
  doctorName: process.env.DOCTOR_NAME || 'Dr. Sharma',
  clinicName: process.env.CLINIC_NAME || 'OPD Sahayak Clinic',
  // Local dev with no Turso account: falls back to a local SQLite file.
  // In production (Vercel), set TURSO_DATABASE_URL (libsql://...) and
  // TURSO_AUTH_TOKEN so every serverless invocation shares the same database.
  tursoUrl: process.env.TURSO_DATABASE_URL || `file:${process.env.DB_PATH || './data/clinic.db'}`,
  tursoAuthToken: process.env.TURSO_AUTH_TOKEN || undefined,
};
