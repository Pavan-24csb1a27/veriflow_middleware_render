require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const authRoutes = require('./routes/auth');
const analyzeRoutes = require('./routes/analyze');
const { router: visionNodeRoutes } = require('./routes/visionNode');
const historyRoutes = require('./routes/history');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Startup env var validation — fail loudly now rather than mysteriously later ---
const REQUIRED_ENV_VARS = ['MONGODB_URI', 'JWT_SECRET', 'GROQ_API_KEY', 'DDGS_SERVICE_URL', 'VISION_NODE_SECRET'];
const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`[server] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// --- CORS: scope to your actual extension, not "*" ---
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json({ limit: '15mb' })); // images arrive as base64 in the JSON body

// --- Routes ---
app.use('/auth', authRoutes);
app.use('/analyze', analyzeRoutes);
app.use('/vision-node', visionNodeRoutes);
app.use('/history', requireAuth, historyRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', mongoConnected: mongoose.connection.readyState === 1 });
});

// --- Connect to MongoDB, then start listening ---
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('[server] MongoDB connected.');
    app.listen(PORT, () => {
      console.log(`[server] VeriFlow middleware running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[server] MongoDB connection failed:', err.message);
    process.exit(1);
  });

// --- Loud shutdown logging ---
// If you're running with `npm run dev` (node --watch), ANY file save in
// this project — even an unrelated one, or an editor autosave — restarts
// this whole process. If that happens while an in-flight request to the
// vision node is open, the underlying TCP/TLS connection gets torn down,
// which surfaces as things like "Client network socket disconnected
// before secure TLS connection was established" on the axios side. These
// logs make that restart impossible to miss when reading server output.
// For actual demo/testing sessions where you don't want this risk, use
// `npm run stable` instead (no file-watching, no surprise restarts).
process.on('SIGTERM', () => {
  console.warn('[server] Received SIGTERM — shutting down (likely a --watch-triggered restart).');
});
process.on('SIGINT', () => {
  console.warn('[server] Received SIGINT — shutting down.');
});