// Vercel entry point: every request under /api/* is routed here (see
// vercel.json), and Express's own router (mounted in server/index.js) handles
// the actual /api/auth, /api/public, /api/admin sub-routes from there.
module.exports = require('../server/index.js');
