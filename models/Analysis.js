const mongoose = require('mongoose');

const analysisSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true, // history is always queried per-user, index this
  },
  inputText: {
    type: String,
    default: '',
  },
  hasImage: {
    type: Boolean,
    default: false,
  },
  // We deliberately do NOT store the raw base64 image blob in Mongo —
  // that would bloat the database fast (each image can be several MB as
  // base64) and MongoDB documents have a 16MB hard cap. If you want to
  // keep the actual image, store it in object storage (S3/Cloudflare R2/
  // etc.) and save just the URL here instead.
  imageUrl: {
    type: String,
    default: null,
  },
  result: {
    // Stored as a flexible blob since the shape of `result` (trust_score,
    // clip_semantic_alignment, image_forensics, etc.) may evolve — a
    // strict sub-schema here would need updating every time main.py's
    // response shape changes.
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
  imagePipelineUsed: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true, // history views typically sort/filter by recency
  },
});

module.exports = mongoose.model('Analysis', analysisSchema);
