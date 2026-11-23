// Vercel serverless entry point - all /api/* requests go through here.
// Vercel dashboard env vars: YOUTUBE_API_KEY, GEMINI_API_KEY (optional).
const { handler } = require('../server/app');
module.exports = (req, res) => handler(req, res);
