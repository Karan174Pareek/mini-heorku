const { spawn } = require('child_process');

class GitServerClient {
  /**
   * Initializes a bare git repository on the PVC in pushr-system and installs post-receive hook.
   *
   * @param {string} slug - Application slug
   * @returns {Promise<void>}
   */
  async initRepo(slug) {
    return new Promise((resolve, reject) => {
      const proc = spawn('kubectl', [
        'exec',
        '-n', 'pushr-system',
        'deployment/pushr-git',
        '--',
        '/app/init-repo.sh',
        slug,
      ]);

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => stdout += d.toString());
      proc.stderr.on('data', d => stderr += d.toString());

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout });
        } else {
          reject(new Error(`Failed to initialize git repository for '${slug}' (code ${code}): ${stderr || stdout}`));
        }
      });

      proc.on('error', reject);
    });
  }
  /**
   * Deletes a bare git repository on the PVC in pushr-system.
   *
   * @param {string} slug - Application slug
   * @returns {Promise<void>}
   */
  async deleteRepo(slug) {
    return new Promise((resolve) => {
      const proc = spawn('kubectl', [
        'exec',
        '-n', 'pushr-system',
        'deployment/pushr-git',
        '--',
        'rm',
        '-rf',
        `/repos/${slug}.git`,
      ]);
      proc.on('close', () => resolve());
      proc.on('error', () => resolve());
    });
  }
}

module.exports = new GitServerClient();
