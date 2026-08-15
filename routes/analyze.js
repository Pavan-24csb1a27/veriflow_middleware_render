const express = require('express');
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const { getActiveVisionNodeUrl } = require('./visionNode');
const Analysis = require('../models/Analysis');
const { runFactCheck } = require('../utils/llm');

const router = express.Router();

const VISION_REQUEST_TIMEOUT_MS = 25000;

// POST /analyze
// Always runs the Groq-based text fact-check (if text is provided).
// Only attempts the image pipeline (ViT/CLIP/reverse-image-search) if a
// vision node is currently registered and reachable — otherwise responds
// with a clear "image processing not available" status instead of
// silently skipping it or hanging on a dead connection.
router.post('/', requireAuth, async (req, res) => {
  const { text = '', images = [], image_url: imageUrl = null } = req.body;

  if (!text.trim() && images.length === 0) {
    return res.status(400).json({ error: 'Provide text, an image, or both.' });
  }

  const responsePayload = {
    status: 'completed',
    text_veracity_report: text.trim() ? null : 'No text asset submitted.',
    trust_score: null,
    image_forensics: null,
    clip_semantic_alignment: null,
    reverse_image_search: null,
    image_pipeline_available: false,
  };

  // --- Run text fact-check (Groq) and image pipeline (laptop, if online)
  // CONCURRENTLY rather than sequentially. Awaiting them one after another
  // means the vision request doesn't even fire until the entire Groq
  // pipeline finishes — needless latency, and it means a slow/failed Groq
  // call can push the vision request later than intended.
  const tasks = [];

  if (text.trim()) {
    tasks.push(
      runFactCheck(text)
        .then((result) => {
          responsePayload.text_veracity_report = result.report;
          responsePayload.trust_score = result.trustScore;
        })
        .catch((err) => {
          console.error('[analyze] fact-check failed:', err.message);
          responsePayload.text_veracity_report = `Component failed: ${err.message}`;
        })
    );
  }

  if (images.length > 0) {
    tasks.push(
      (async () => {
        const visionNodeUrl = await getActiveVisionNodeUrl();

        if (!visionNodeUrl) {
          responsePayload.image_forensics = {
            error: 'Image processing not available right now — the vision server is offline. Turn it on and try again.',
          };
          responsePayload.clip_semantic_alignment = images.length && text.trim()
            ? { error: 'Image processing not available right now — the vision server is offline.' }
            : null;
          responsePayload.image_pipeline_available = false;
          return;
        }

        try {
          const visionResponse = await axios.post(
            `${visionNodeUrl}/analyze`,
            { text, images, image_url: imageUrl },
            {
              timeout: VISION_REQUEST_TIMEOUT_MS,
              headers: {
                // Required for free-tier ngrok URLs — without this header,
                // ngrok serves an interstitial browser warning page instead
                // of forwarding the request, which can surface here as a
                // malformed response or connection reset rather than a
                // clean error.
                'ngrok-skip-browser-warning': 'true',
              },
            }
          );

          responsePayload.image_forensics = visionResponse.data.image_forensics;
          responsePayload.clip_semantic_alignment = visionResponse.data.clip_semantic_alignment;
          responsePayload.reverse_image_search = visionResponse.data.reverse_image_search;
          responsePayload.image_pipeline_available = true;
        } catch (err) {
          console.error('[analyze] vision node request failed:', err.message);
          responsePayload.image_forensics = {
            error: `Vision server did not respond in time or errored: ${err.message}`,
          };
          responsePayload.image_pipeline_available = false;
        }
      })()
    );
  }

  await Promise.allSettled(tasks);

  // --- Persist to history (best-effort — a logging failure shouldn't
  // fail the user's actual request) ---
  try {
    await Analysis.create({
      userId: req.user.id,
      inputText: text,
      hasImage: images.length > 0,
      imageUrl: imageUrl,
      result: responsePayload,
      imagePipelineUsed: responsePayload.image_pipeline_available,
    });
  } catch (err) {
    console.error('[analyze] failed to save history entry:', err.message);
  }

  res.json(responsePayload);
});

module.exports = router;