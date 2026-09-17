// Normalizes a phone number the user typed (strips spaces/dashes/+ and a
// leading 91 country code) down to a bare 10-digit string, and validates it
// looks like a real Indian mobile number (10 digits, starting 6-9).

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  // Drop a leading "91" country code only if that still leaves exactly 10 digits.
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  return digits;
}

function isValidPhone(value) {
  return /^[6-9]\d{9}$/.test(normalizePhone(value));
}

module.exports = { normalizePhone, isValidPhone };
