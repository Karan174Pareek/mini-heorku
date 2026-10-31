const express = require('express');
const router = express.Router();
const Release = require('../models/Release');
const buildQueue = require('../services/builder/BuildQueue');
const deployer = require('../services/deployer/Deployer');

/**
 * POST /api/releases/:id/deploy
 * Manually deploys or re-deploys an existing release without rebuilding.
 */
router.post('/:id/deploy', async (req, res) => {
  try {
    const release = await Release.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }
    if (!release.image) {
      return res.status(400).json({ error: 'Release does not have an image to deploy' });
    }

    const result = await deployer.deploy(release);
    res.json({
      message: 'Deployment complete',
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/releases/:id
 * Retrieve release details.
 */
router.get('/:id', async (req, res) => {
  try {
    const release = await Release.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }
    res.json(release);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/releases/:id/build-logs
 * Server-Sent Events (SSE) endpoint for live and replayed build logs.
 */
router.get('/:id/build-logs', async (req, res) => {
  try {
    const release = await Release.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Replay stored log
    if (release.buildLog) {
      sendEvent('log', { message: release.buildLog });
    }

    // If release is already completed, send done and end
    if (['succeeded', 'failed'].includes(release.status)) {
      sendEvent('done', { status: release.status, image: release.image });
      return res.end();
    }

    // If currently running, stream live events
    const logEvent = `log:${release._id}`;
    const doneEvent = `done:${release._id}`;

    const onLog = (chunk) => {
      sendEvent('log', { message: chunk });
    };

    const onDone = (result) => {
      sendEvent('done', result);
      cleanup();
      res.end();
    };

    const cleanup = () => {
      buildQueue.removeListener(logEvent, onLog);
      buildQueue.removeListener(doneEvent, onDone);
    };

    buildQueue.on(logEvent, onLog);
    buildQueue.on(doneEvent, onDone);

    req.on('close', cleanup);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

module.exports = router;
