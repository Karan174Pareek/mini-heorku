const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Release = require('../models/Release');
const buildQueue = require('../services/builder/BuildQueue');

/**
 * POST /api/internal/releases/build
 * Called by git server post-receive hook.
 */
router.post('/build', async (req, res) => {
  try {
    const { appSlug, commitSha, ref } = req.body;
    if (!appSlug || !commitSha) {
      return res.status(400).json({ error: 'appSlug and commitSha are required' });
    }

    const shortSha = commitSha.substring(0, 7);
    const reposBase = process.env.REPOS_PATH || path.join(process.cwd(), 'repos');
    const repoPath = path.join(reposBase, `${appSlug}.git`);

    const release = new Release({
      appSlug,
      commitSha,
      shortSha,
      ref: ref || 'refs/heads/main',
      status: 'queued',
      strategy: 'dockerfile', // updated dynamically by queue
    });
    await release.save();

    // Trigger queue in background
    await buildQueue.enqueue(release, repoPath);

    res.status(202).json({
      message: 'Build accepted and queued',
      releaseId: release._id,
      appSlug,
      commitSha,
    });
  } catch (err) {
    console.error('Error queuing build:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/internal/releases/:id/tarball
 * Streams a tar.gz archive of the exported commit workspace for build Jobs.
 */
router.get('/:id/tarball', async (req, res) => {
  try {
    const workspaceDir = buildQueue.getWorkspaceDir(req.params.id);
    if (!workspaceDir || !fs.existsSync(workspaceDir)) {
      return res.status(404).json({ error: 'Build workspace not active or found' });
    }

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="source-${req.params.id}.tar.gz"`);

    const tar = spawn('tar', ['-czf', '-', '.'], { cwd: workspaceDir });
    tar.stdout.pipe(res);
    tar.stderr.on('data', d => console.error('Tar error:', d.toString()));
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

module.exports = router;
