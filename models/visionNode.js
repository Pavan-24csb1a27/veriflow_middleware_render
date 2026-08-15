const mongoose = require('mongoose');

// Single-document collection (there's only ever one "current" vision node
// for a personal project like this). The laptop calls POST /vision-node/register
// on startup to write itself in here; the middleware checks `lastSeenAt`
// before routing any image-analysis request to decide if the laptop is
// actually online right now.
const visionNodeSchema = new mongoose.Schema({
  nodeId: {
    type: String,
    default: 'primary', // fixed key — upsert against this always
    unique: true,
  },
  url: {
    type: String,
    required: true, // the laptop's current ngrok URL
  },
  lastSeenAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('VisionNode', visionNodeSchema);
