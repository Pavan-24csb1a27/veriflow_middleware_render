const express = require('express');
const Analysis = require('../models/Analysis');

const router = express.Router();
// Note: requireAuth is already applied to this whole router in server.js
// (app.use('/history', requireAuth, historyRoutes)), so req.user is
// guaranteed to be set in every handler below.

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// GET /history?page=1&pageSize=20
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE)
    );

    const [entries, total] = await Promise.all([
      Analysis.find({ userId: req.user.id })
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      Analysis.countDocuments({ userId: req.user.id }),
    ]);

    res.json({
      entries,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    console.error('[history] list error:', err.message);
    res.status(500).json({ error: 'Could not fetch history.' });
  }
});

// GET /history/:id — fetch a single past analysis in full
router.get('/:id', async (req, res) => {
  try {
    const entry = await Analysis.findOne({ _id: req.params.id, userId: req.user.id });
    if (!entry) {
      return res.status(404).json({ error: 'Analysis not found.' });
    }
    res.json(entry);
  } catch (err) {
    // Includes CastError for malformed ObjectIds — treat as not-found
    // rather than a 500, since it's really a client input problem.
    res.status(404).json({ error: 'Analysis not found.' });
  }
});

// DELETE /history/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await Analysis.deleteOne({ _id: req.params.id, userId: req.user.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Analysis not found.' });
    }
    res.json({ message: 'Deleted.' });
  } catch (err) {
    res.status(404).json({ error: 'Analysis not found.' });
  }
});

module.exports = router;
