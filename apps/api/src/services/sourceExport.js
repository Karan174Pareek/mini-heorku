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
 * @param {string} [appSlug] - App slug
 * @returns {Promise<{ sourceDir: string, hasDockerfile: boolean, cleanup: () => Promise<void> }>}
 */
async function exportCommit(repoPath, commitSha, appSlug) {
  const isTestMode = process.env.TEST_MODE === 'true';
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

    // 1. Export commit from the real bare repo inside pushr-git pod in pushr-system
    if (appSlug && commitSha) {
      try {
        await new Promise((resolve, reject) => {
          const gitArchive = spawn('kubectl', [
            'exec',
            '-n', 'pushr-system',
            'deployment/pushr-git',
            '--',
            'git',
            `--git-dir=/repos/${appSlug}.git`,
            'archive',
            commitSha,
          ]);

          const tarExtract = spawn('tar', ['-x', '-C', tempDir]);

          gitArchive.stdout.pipe(tarExtract.stdin);

          let errorOutput = '';
          gitArchive.stderr.on('data', d => errorOutput += d.toString());
          tarExtract.stderr.on('data', d => errorOutput += d.toString());

          tarExtract.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`git archive extract failed (code ${code}): ${errorOutput}`));
          });

          gitArchive.on('error', reject);
          tarExtract.on('error', reject);
        });

        // Verify that files were actually extracted
        const files = await fs.promises.readdir(tempDir);
        if (files.length > 0) {
          exported = true;
        }
      } catch (err) {
        if (!isTestMode) {
          throw new Error(`Real git archive export failed for '${appSlug}' (commit ${commitSha}): ${err.message}`);
        }
      }
    }

    // 2. Fallback for sample apps / synthetic tests ONLY when TEST_MODE=true
    if (!exported) {
      if (!isTestMode) {
        throw new Error(`TEST_MODE is disabled and no bare repo exists for app '${appSlug}' (commit ${commitSha})`);
      }

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

      if (commitSha && commitSha.toLowerCase().includes('failhealth')) {
        const nodeServer = path.join(tempDir, 'server.js');
        if (fs.existsSync(nodeServer)) {
          let code = await fs.promises.readFile(nodeServer, 'utf8');
          code = code.replace(/res(\.status\(200\))?\.json\(\{\s*status:\s*['"]ok['"],\s*app:\s*['"]node-app['"]\s*\}\);?/, "res.status(500).json({ error: 'health failed' });");
          await fs.promises.writeFile(nodeServer, code);
        }
        const pyApp = path.join(tempDir, 'app.py');
        if (fs.existsSync(pyApp)) {
          let code = await fs.promises.readFile(pyApp, 'utf8');
          code = code.replace("return jsonify({\"status\": \"ok\", \"app\": \"python-app\"}), 200", "return jsonify({\"error\": \"health check failing\"}), 500");
          await fs.promises.writeFile(pyApp, code);
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
