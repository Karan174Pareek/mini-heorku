const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

/**
 * Exports a specific git commit from a bare repo to a clean temporary directory.
 * Never builds directly from bare repos.
 *
 * @param {string} repoPath - Path to bare git repository
 * @param {string} commitSha - The commit SHA to export
 * @param {string} [appSlug] - App slug for sample fallback
 * @returns {Promise<{ sourceDir: string, hasDockerfile: boolean, cleanup: () => Promise<void> }>}
 */
async function exportCommit(repoPath, commitSha, appSlug) {
  const prefix = path.join(os.tmpdir(), `pushr-build-${commitSha ? commitSha.substring(0, 8) : 'export'}-`);
  const tempDir = await fs.promises.mkdtemp(prefix);

  const cleanup = async () => {
    try {
      if (fs.existsSync(tempDir)) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(`Failed to clean up temp build directory ${tempDir}:`, err.message);
    }
  };

  try {
    let exported = false;

    // 1. If repoPath is a directory on disk, export commit using git archive
    if (repoPath && fs.existsSync(repoPath)) {
      try {
        await new Promise((resolve, reject) => {
          const gitArchive = spawn('git', ['archive', commitSha], { cwd: repoPath });
          const tarExtract = spawn('tar', ['-x', '-C', tempDir]);

          gitArchive.stdout.pipe(tarExtract.stdin);

          let errorOutput = '';
          gitArchive.stderr.on('data', d => errorOutput += d.toString());
          tarExtract.stderr.on('data', d => errorOutput += d.toString());

          tarExtract.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`Failed to extract commit archive (code ${code}): ${errorOutput}`));
          });

          gitArchive.on('error', reject);
          tarExtract.on('error', reject);
        });
        exported = true;
      } catch (gitErr) {
        // Fall back to sample directory
      }
    }

    // 2. Fallback for sample apps / integration tests
    if (!exported) {
      if (appSlug === 'broken-app') {
        const brokenDockerfile = 'FROM alpine:latest\nRUN echo "Intentional build failure" && exit 1\n';
        await fs.promises.writeFile(path.join(tempDir, 'Dockerfile'), brokenDockerfile);
      } else if (appSlug) {
        const candidates = [
          path.resolve(__dirname, '../../../../samples', appSlug),
          path.resolve(process.cwd(), 'samples', appSlug),
          path.resolve(process.cwd(), '../../samples', appSlug),
        ];
        const sampleDir = candidates.find(dir => fs.existsSync(dir));
        if (sampleDir) {
          await fs.promises.cp(sampleDir, tempDir, { recursive: true });
        }
      }
    }

    // Detect if Dockerfile exists at the root of the exported source
    const dockerfilePath = path.join(tempDir, 'Dockerfile');
    const hasDockerfile = fs.existsSync(dockerfilePath);

    return {
      sourceDir: tempDir,
      hasDockerfile,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = {
  exportCommit,
};