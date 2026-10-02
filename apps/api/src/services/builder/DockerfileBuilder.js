const Builder = require('./Builder');
const { getBatchApi, getCoreApi, ensureNamespace } = require('../k8s');

/**
 * DockerfileBuilder
 * Builds container images using Kaniko in a Kubernetes Job.
 */
class DockerfileBuilder extends Builder {
  async build(release, options = {}) {
    const {
      registryHost = process.env.REGISTRY_HOST_INTERNAL || 'k3d-pushr-registry:5000',
      namespace = process.env.BUILDS_NAMESPACE || 'pushr-builds',
      apiInternalUrl = process.env.API_INTERNAL_URL || 'http://pushr-api:3000',
      onLog = () => {},
      signal,
    } = options;

    await ensureNamespace(namespace);

    const appSlug = release.appSlug;
    const shortSha = release.shortSha || release.commitSha.substring(0, 7);
    const destination = `${registryHost}/${appSlug}:${shortSha}`;
    const jobName = `build-${appSlug}-${shortSha}-${Date.now().toString(36)}`;

    onLog(`[Pushr Builder] Strategy: DockerfileBuilder (Kaniko)\n`);
    onLog(`[Pushr Builder] Target image destination: ${destination}\n`);
    onLog(`[Pushr Builder] Creating build Job '${jobName}' in namespace '${namespace}'...\n`);

    const batchApi = await getBatchApi();
    const coreApi = await getCoreApi();

    const jobManifest = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace,
        labels: {
          app: 'pushr-builder',
          strategy: 'dockerfile',
          appSlug,
          shortSha,
        },
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 300,
        template: {
          metadata: {
            labels: {
              jobName,
              appSlug,
            },
          },
          spec: {
            restartPolicy: 'Never',
            volumes: [
              {
                name: 'workspace',
                emptyDir: {},
              },
            ],
            initContainers: [
              {
                name: 'fetch-source',
                image: 'curlimages/curl:8.10.1',
                command: ['/bin/sh', '-c'],
                args: [
                  `echo "Fetching source tarball for release ${release._id || release.id}..." && ` +
                  `curl -f -sSL "${apiInternalUrl}/api/internal/releases/${release._id || release.id}/tarball" | tar -xz -C /workspace && ` +
                  `echo "Source successfully unpacked into /workspace"`
                ],
                volumeMounts: [
                  {
                    name: 'workspace',
                    mountPath: '/workspace',
                  },
                ],
              },
            ],
            containers: [
              {
                name: 'kaniko',
                image: 'gcr.io/kaniko-project/executor:v1.23.2-debug',
                args: [
                  '--context=dir:///workspace',
                  '--dockerfile=Dockerfile',
                  `--destination=${destination}`,
                  '--insecure',
                  '--skip-tls-verify',
                  '--cache=true',
                  '--verbosity=info',
                ],
                volumeMounts: [
                  {
                    name: 'workspace',
                    mountPath: '/workspace',
                  },
                ],
              },
            ],
          },
        },
      },
    };

    let logBuffer = '';

    try {
      await batchApi.createNamespacedJob({
        namespace,
        body: jobManifest,
      });

      // Poll pod status and stream logs until completion
      const result = await this.watchJob(jobName, namespace, onLog, signal);
      return {
        image: destination,
        digest: result.digest || `${destination}@sha256:unknown`,
      };
    } catch (err) {
      // Clean up job if still running
      try {
        await batchApi.deleteNamespacedJob({
          name: jobName,
          namespace,
          propagationPolicy: 'Background',
        });
      } catch (cleanupErr) {
        // ignore deletion errors
      }
      throw err;
    }
  }

  /**
   * Watches a Kubernetes Job until it reaches Succeeded or Failed state.
   */
  async watchJob(jobName, namespace, onLog, signal) {
    const batchApi = await getBatchApi();
    const coreApi = await getCoreApi();

    let podName = null;
    let logStreamStarted = false;

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          if (signal && signal.aborted) {
            clearInterval(interval);
            return reject(new Error('Build cancelled: timeout exceeded.'));
          }

          // 1. Check Job status
          const jobRes = await batchApi.readNamespacedJobStatus({ name: jobName, namespace });
          const status = jobRes.status || {};

          // 2. Find associated pod
          if (!podName) {
            const podsRes = await coreApi.listNamespacedPod({
              namespace,
              labelSelector: `jobName=${jobName}`,
            });
            if (podsRes.items && podsRes.items.length > 0) {
              podName = podsRes.items[0].metadata.name;
            }
          }

          // 3. Stream pod logs if available
          if (podName) {
            try {
              const logsRes = await coreApi.readNamespacedPodLog({
                name: podName,
                namespace,
                container: 'kaniko',
                follow: false,
              });
              if (logsRes && typeof logsRes === 'string') {
                onLog(logsRes);
              }
            } catch (podLogErr) {
              // container may still be starting or in init container
            }
          }

          if (status.succeeded && status.succeeded > 0) {
            clearInterval(interval);
            onLog(`\n[Pushr Builder] Job ${jobName} completed successfully!\n`);
            return resolve({ success: true });
          }

          if (status.failed && status.failed > 0) {
            clearInterval(interval);
            return reject(new Error(`Kaniko build Job ${jobName} failed.`));
          }
        } catch (pollErr) {
          // Retry on intermittent API error
        }
      }, 2500);
    });
  }
}

module.exports = DockerfileBuilder;
