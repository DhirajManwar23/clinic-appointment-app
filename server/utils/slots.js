// ---- Clinic schedule configuration ----
// The clinic is open every day of the week by default. The doctor can close
// specific dates or specific time slots from the admin panel (see
// closed_days / closed_slots tables in db.js) — this file just generates the
// calendar and holds the fixed list of slot times.

const TIME_SLOTS = [
  '2:45 PM', '3:00 PM', '3:15 PM', '3:30 PM', '3:45 PM', '4:00 PM',
  '4:15 PM', '4:30 PM', '4:45 PM', '5:00 PM', '5:15 PM', '5:30 PM',
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Returns the next `numDays` calendar days starting tomorrow (Mon..Sun, every day).
function generateNextDays(numDays = 10) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const results = [];

  for (let i = 1; i <= numDays; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    results.push({
      dayName: DAY_NAMES[date.getDay()],
      date: toISODate(date),
      displayDate: date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
    });
  }
  return results;
}

// Basic sanity check that a string looks like a real YYYY-MM-DD date.
function parseDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || '')) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return { date, dayName: DAY_NAMES[date.getDay()] };
}

module.exports = {
  TIME_SLOTS,
  DAY_NAMES,
  generateNextDays,
  parseDate,
  toISODate,
};
