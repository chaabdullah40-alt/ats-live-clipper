// ATS Live Clipper - local server entry point
// Run:  npm start   (then open http://localhost:3000)
const http = require('http');
const { handler } = require('./app');
const PORT = process.env.PORT || 3000;
http.createServer(handler).listen(PORT, () => {
  console.log(`ATS Live Clipper running at http://localhost:${PORT}`);
  console.log(`YouTube API configured: ${!!process.env.YOUTUBE_API_KEY}`);
  console.log(`Gemini configured: ${!!process.env.GEMINI_API_KEY}`);
});
