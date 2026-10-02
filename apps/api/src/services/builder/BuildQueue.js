const EventEmitter = require('events');
const Release = require('../../models/Release');
const { exportCommit } = require('../sourceExport');
const DockerfileBuilder = require('./DockerfileBuilder');
const BuildpackBuilder = require('./BuildpackBuilder');

class BuildQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxConcurrent = options.maxConcurrent || parseInt(process.env.MAX_CONCURRENT_BUILDS || '2', 10);
    this.timeoutMs = options.timeoutMs || parseInt(process.env.BUILD_TIMEOUT_SECONDS || '600', 10) * 1000;
    this.runningCount = 0;
    this.queue = [];
    this.dockerfileBuilder = new DockerfileBuilder();
    this.buildpackBuilder = new BuildpackBuilder();
    this.activeWorkspaces = new Map(); // releaseId -> workspaceDir for tarball downloads
  }

  /**
   * Enqueues a release for building.
   * Handles idempotency: if the commit SHA is already built, reuses the image.
   *
   * @param {Object} release - Mongoose Release document
   * @param {string} repoPath - Local path to bare git repository
   */
  async enqueue(release, repoPath) {
    // 1. Idempotency check: look for an existing succeeded release with identical SHA
    const existing = await Release.findOne({
      appSlug: release.appSlug,
      commitSha: release.commitSha,
      status: 'succeeded',
      image: { $ne: null },
      _id: { $ne: release._id },
    }).sort({ createdAt: -1 });

    if (existing) {
      release.status = 'succeeded';
      release.image = existing.image;
      release.digest = existing.digest;
      release.strategy = existing.strategy;
      release.buildLog = `[Pushr Builder] Reusing existing image for commit ${release.commitSha.substring(0, 7)}: ${existing.image}\n`;
      release.startedAt = new Date();
      release.finishedAt = new Date();
      await release.save();

      this.emit(`log:${release._id}`, release.buildLog);
      this.emit(`done:${release._id}`, { status: 'succeeded', image: release.image });
      return release;
    }

    // Set queued
    release.status = 'queued';
    await release.save();

    this.queue.push({ release, repoPath });
    this.processNext();
    return release;
  }

  async processNext() {
    if (this.runningCount >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const { release, repoPath } = this.queue.shift();
    this.runningCount++;

    this.runBuild(release, repoPath).finally(() => {
      this.runningCount--;
      this.processNext();
    });
  }

  async runBuild(release, repoPath) {
    let sourceContext = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let fullLog = '';
    const appendLog = (chunk) => {
      fullLog += chunk;
      this.emit(`log:${release._id}`, chunk);
    };

    try {
      release.status = 'building';
      release.startedAt = new Date();
      await release.save();

      appendLog(`[Pushr Builder] Starting build for ${release.appSlug} (commit: ${release.shortSha})\n`);

      // 1. Clean source checkout
      sourceContext = await exportCommit(repoPath, release.commitSha, release.appSlug);
      this.activeWorkspaces.set(release._id.toString(), sourceContext.sourceDir);

      // 2. Select strategy
      const strategy = sourceContext.hasDockerfile ? 'dockerfile' : 'buildpack';
      release.strategy = strategy;
      await release.save();

      const builder = strategy === 'dockerfile' ? this.dockerfileBuilder : this.buildpackBuilder;

      // 3. Execute build
      const buildResult = await builder.build(release, {
        sourceDir: sourceContext.sourceDir,
        signal: controller.signal,
        onLog: appendLog,
      });

      // 4. Record success
      release.status = 'succeeded';
      release.image = buildResult.image;
      release.digest = buildResult.digest;
      release.buildLog = fullLog;
      release.finishedAt = new Date();
      await release.save();

      appendLog(`[Pushr Builder] Build succeeded! Image: ${buildResult.image}\n`);
      this.emit(`done:${release._id}`, { status: 'succeeded', image: buildResult.image });
    } catch (err) {
      release.status = 'failed';
      release.error = err.message;
      appendLog(`\n[Pushr Builder ERROR] ${err.message}\n`);
      release.buildLog = fullLog;
      release.finishedAt = new Date();
      await release.save();

      this.emit(`done:${release._id}`, { status: 'failed', error: err.message });
    } finally {
      clearTimeout(timeout);
      this.activeWorkspaces.delete(release._id.toString());
      if (sourceContext && sourceContext.cleanup) {
        await sourceContext.cleanup();
      }
    }
  }

  getWorkspaceDir(releaseId) {
    return this.activeWorkspaces.get(releaseId.toString());
  }
}

// Singleton queue instance
const buildQueue = new BuildQueue();
module.exports = buildQueue;
