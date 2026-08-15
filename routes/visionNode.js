const express = require('express');
const VisionNode = require('../models/visionNode');

const router = express.Router();

// How stale a registration can be before we consider the laptop offline.
// The laptop should re-ping this endpoint more often than this interval
// (see the heartbeat script) so lastSeenAt stays fresh while it's running.
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// POST /vision-node/register
// Called by the laptop's FastAPI service (or a small heartbeat script)
// on startup and periodically afterward. Requires a shared secret so
// random callers can't register a malicious URL as the "vision node" —
// that would let someone else's server receive images/text your users
// submit through the extension.
router.post('/register', async (req, res) => {
  try {
    const { url, secret } = req.body;

    if (!secret || secret !== process.env.VISION_NODE_SECRET) {
      return res.status(403).json({ error: 'Invalid registration secret.' });
    }
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required.' });
    }
    try {
      new URL(url); // throws if not a valid URL
    } catch {
      return res.status(400).json({ error: 'url is not a valid URL.' });
    }

    await VisionNode.findOneAndUpdate(
      { nodeId: 'primary' },
      { url, lastSeenAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ message: 'Vision node registered.', url });
  } catch (err) {
    console.error('[vision-node/register] error:', err.message);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

// GET /vision-node/status
// Lets the extension (or you, manually) check whether the image pipeline
// is currently available before even attempting an image analysis.
router.get('/status', async (req, res) => {
  try {
    const node = await VisionNode.findOne({ nodeId: 'primary' });

    if (!node) {
      return res.json({ available: false, reason: 'No vision node has ever registered.' });
    }

    const isStale = Date.now() - node.lastSeenAt.getTime() > STALE_THRESHOLD_MS;
    if (isStale) {
      return res.json({
        available: false,
        reason: `Vision node last seen ${node.lastSeenAt.toISOString()} — considered offline.`,
      });
    }

    res.json({ available: true, lastSeenAt: node.lastSeenAt });
  } catch (err) {
    console.error('[vision-node/status] error:', err.message);
    res.status(500).json({ error: 'Could not check vision node status.' });
  }
});

// Internal helper (not a route) — used by the /analyze route to get a
// live, freshness-checked URL right before forwarding a request.
async function getActiveVisionNodeUrl() {
  const node = await VisionNode.findOne({ nodeId: 'primary' });
  if (!node) return null;

  const isStale = Date.now() - node.lastSeenAt.getTime() > STALE_THRESHOLD_MS;
  if (isStale) return null;

  return node.url;
}

module.exports = { router, getActiveVisionNodeUrl };