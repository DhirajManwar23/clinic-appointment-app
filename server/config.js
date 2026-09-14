require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_change_me',
  adminUsername: process.env.ADMIN_USERNAME || 'doctor',
  adminPassword: process.env.ADMIN_PASSWORD || 'changeme123',
  doctorName: process.env.DOCTOR_NAME || 'Dr. Sharma',
  clinicName: process.env.CLINIC_NAME || 'OPD Sahayak Clinic',
  dbPath: process.env.DB_PATH || './data/clinic.db',
};
