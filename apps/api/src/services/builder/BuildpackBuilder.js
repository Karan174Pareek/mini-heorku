const Builder = require('./Builder');
const { getBatchApi, getCoreApi, ensureNamespace } = require('../k8s');
const { spawn } = require('child_process');

/**
 * BuildpackBuilder
 * Builds container images using Cloud Native Buildpacks (CNB).
 * Default builder: paketobuildpacks/builder-jammy-base
 */
class BuildpackBuilder extends Builder {
  constructor(builderImage = 'paketobuildpacks/builder-jammy-base') {
    super();
    this.builderImage = builderImage;
  }

  async build(release, options = {}) {
    const {
      registryHost = process.env.REGISTRY_HOST_INTERNAL || 'k3d-pushr-registry:5000',
      namespace = process.env.BUILDS_NAMESPACE || 'pushr-builds',
      apiInternalUrl = process.env.API_INTERNAL_URL || 'http://host.k3d.internal:3000',
      sourceDir,
      onLog = () => {},
      signal,
    } = options;

    const appSlug = release.appSlug;
    const shortSha = release.shortSha || release.commitSha.substring(0, 7);
    const destination = `${registryHost}/${appSlug}:${shortSha}`;
    const jobName = `pack-${appSlug}-${shortSha}-${Date.now().toString(36)}`;

    onLog(`[Pushr Builder] Strategy: BuildpackBuilder (Cloud Native Buildpacks)\n`);
    onLog(`[Pushr Builder] Builder image: ${this.builderImage}\n`);
    onLog(`[Pushr Builder] Target destination: ${destination}\n`);

    // In cluster execution mode via Kubernetes Job running CNB creator
    try {
      await ensureNamespace(namespace);
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
            strategy: 'buildpack',
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
              securityContext: { fsGroup: 1000 },
              hostAliases: [
                {
                  ip: process.env.HOST_GATEWAY_IP || '192.168.65.254',
                  hostnames: ['host.k3d.internal'],
                },
              ],
              volumes: [
                {
                  name: 'workspace',
                  emptyDir: {},
                },
                {
                  name: 'layers',
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
                    `curl -f -sSL -H "X-Pushr-Internal-Secret: $INTERNAL_SECRET" "${apiInternalUrl}/api/internal/releases/${release._id || release.id}/tarball" | tar -xz -C /workspace && ` +
                    `chmod -R 777 /workspace /layers && ` +
                    `echo "Source successfully unpacked into /workspace"`
                  ],
                  env: [
                    {
                      name: 'INTERNAL_SECRET',
                      valueFrom: {
                        secretKeyRef: {
                          name: 'pushr-internal-secret',
                          key: 'secret',
                        },
                      },
                    },
                  ],
                  securityContext: {
                    runAsUser: 0,
                  },
                  volumeMounts: [
                    {
                      name: 'workspace',
                      mountPath: '/workspace',
                    },
                    {
                      name: 'layers',
                      mountPath: '/layers',
                    },
                  ],
                },
              ],
              containers: [
                {
                  name: 'cnb-creator',
                  image: this.builderImage,
                  imagePullPolicy: 'IfNotPresent',
                  command: ['/cnb/lifecycle/creator'],
                  args: [
                    '-app=/workspace',
                    `-layers=/layers`,
                    `-skip-restore`,
                    `-insecure-registry=${registryHost}`,
                    destination,
                  ],
                  env: [
                    {
                      name: 'CNB_PLATFORM_API',
                      value: '0.13',
                    },
                  ],

                  volumeMounts: [
                    {
                      name: 'workspace',
                      mountPath: '/workspace',
                    },
                    {
                      name: 'layers',
                      mountPath: '/layers',
                    },
                  ],
                },
              ],
            },
          },
        },
      };

      onLog(`[Pushr Builder] Creating build Job '${jobName}' in namespace '${namespace}'...\n`);
      await batchApi.createNamespacedJob({
        namespace,
        body: jobManifest,
      });

      await this.watchJob(jobName, namespace, onLog, signal);
      return {
        image: destination,
        digest: `${destination}@sha256:unknown`,
      };
    } catch (k8sErr) {
      onLog(`[Pushr Builder] In-cluster buildpack job encountered: ${k8sErr.message}\n`);
      
      // Fallback mechanism if host docker socket or pack CLI is available (per ADR & requirement 3)
      if (sourceDir && process.env.USE_PACK_CLI === 'true') {
        onLog(`[Pushr Builder] Attempting fallback buildpack execution with pack CLI...\n`);
        return await this.buildWithPackCli(sourceDir, destination, onLog, signal);
      }
      throw k8sErr;
    }
  }

  async watchJob(jobName, namespace, onLog, signal) {
    const batchApi = await getBatchApi();
    const coreApi = await getCoreApi();
    let podName = null;

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          if (signal && signal.aborted) {
            clearInterval(interval);
            return reject(new Error('Buildpack build cancelled: timeout exceeded.'));
          }

          const jobRes = await batchApi.readNamespacedJobStatus({ name: jobName, namespace });
          const status = jobRes.status || {};

          if (!podName) {
            const podsRes = await coreApi.listNamespacedPod({
              namespace,
              labelSelector: `jobName=${jobName}`,
            });
            if (podsRes.items && podsRes.items.length > 0) {
              podName = podsRes.items[0].metadata.name;
            }
          }

          if (podName) {
            try {
              const logsRes = await coreApi.readNamespacedPodLog({
                name: podName,
                namespace,
                container: 'cnb-creator',
                follow: false,
              });
              if (logsRes && typeof logsRes === 'string') {
                onLog(logsRes);
              }
            } catch (e) {
              // container initializing
            }
          }

          if (status.succeeded && status.succeeded > 0) {
            clearInterval(interval);
            onLog(`\n[Pushr Builder] Buildpack Job ${jobName} completed successfully!\n`);
            return resolve({ success: true });
          }

          if (status.failed && status.failed > 0) {
            clearInterval(interval);
            return reject(new Error(`Buildpack build Job ${jobName} failed.`));
          }
        } catch (e) {
          // ignore transient errors
        }
      }, 2500);
    });
  }

  async buildWithPackCli(sourceDir, destination, onLog, signal) {
    return new Promise((resolve, reject) => {
      const args = [
        'build', destination,
        '--builder', this.builderImage,
        '--publish',
        '--insecure-registry',
        '--path', sourceDir,
      ];

      const child = spawn('pack', args, { cwd: sourceDir });
      if (signal) {
        signal.addEventListener('abort', () => {
          child.kill();
          reject(new Error('Pack build timed out.'));
        });
      }

      child.stdout.on('data', d => onLog(d.toString()));
      child.stderr.on('data', d => onLog(d.toString()));

      child.on('close', code => {
        if (code === 0) {
          resolve({
            image: destination,
            digest: `${destination}@sha256:unknown`,
          });
        } else {
          reject(new Error(`Pack build failed with code ${code}`));
        }
      });

      child.on('error', reject);
    });
  }
}

module.exports = BuildpackBuilder;
