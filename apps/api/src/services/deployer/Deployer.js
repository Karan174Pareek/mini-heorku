const { getCoreApi, getAppsApi, getNetworkingApi, ensureNamespace, isNotFoundError } = require('../k8s');
const App = require('../../models/App');
const Release = require('../../models/Release');

class Deployer {
  /**
   * Deploys a release by creating/updating Namespace, Deployment, Service, and Ingress.
   * Tracks rollout status until completion or timeout (default 120s).
   *
   * @param {Object} release - Mongoose Release document
   * @param {Object} options - { onLog, timeoutMs }
   * @returns {Promise<Object>} - Deployment summary { status, appSlug, releaseId, url }
   */
  async deploy(release, options = {}) {
    const onLog = options.onLog || (() => {});
    const timeoutMs = options.timeoutMs || parseInt(process.env.ROLLOUT_TIMEOUT_SECONDS || process.env.DEPLOY_TIMEOUT_SECONDS || '120', 10) * 1000;
    const appSlug = release.appSlug;
    const namespace = `apps-${appSlug}`;

    onLog(`\n[Pushr Deployer] Starting deployment for app '${appSlug}' (release ${release._id || release.id})...\n`);

    // 1. Update release status to deploying
    release.deployStatus = 'deploying';
    await release.save();

    // 2. Fetch or create App record to get envVars
    let app = await App.findOne({ slug: appSlug });
    if (!app) {
      app = new App({
        slug: appSlug,
        gitToken: 'default_token',
        envVars: {},
      });
      await app.save();
    }
    app.deployStatus = 'deploying';
    await app.save();

    try {
      // 3. Ensure per-app namespace exists
      await ensureNamespace(namespace);
      onLog(`[Pushr Deployer] Ensured namespace '${namespace}'.\n`);

      // 4. Resolve PORT and environment variables
      let envPort = '8080';
      if (app.envVars) {
        if (typeof app.envVars.get === 'function' && app.envVars.get('PORT')) {
          envPort = app.envVars.get('PORT');
        } else if (app.envVars.PORT) {
          envPort = app.envVars.PORT;
        }
      }
      const portNumber = parseInt(envPort, 10) || 8080;

      const envList = [{ name: 'PORT', value: String(portNumber) }];
      if (app.envVars) {
        const entries = typeof app.envVars.entries === 'function'
          ? Array.from(app.envVars.entries())
          : Object.entries(app.envVars);
        for (const [k, v] of entries) {
          if (k !== 'PORT') {
            envList.push({ name: String(k), value: String(v) });
          }
        }
      }

      // 5. Construct Deployment manifest (2 replicas, maxSurge: 1, maxUnavailable: 0, probes, limits)
      const deploymentManifest = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: appSlug,
          namespace,
          labels: {
            app: appSlug,
            'pushr.io/app': appSlug,
          },
        },
        spec: {
          replicas: 2,
          minReadySeconds: 3,
          strategy: {
            type: 'RollingUpdate',
            rollingUpdate: {
              maxSurge: 1,
              maxUnavailable: 0,
            },
          },
          selector: {
            matchLabels: {
              app: appSlug,
            },
          },
          template: {
            metadata: {
              labels: {
                app: appSlug,
                'pushr.io/app': appSlug,
                'pushr.io/release-id': (release._id || release.id).toString(),
                'pushr.io/commit-sha': (release.shortSha || release.commitSha.substring(0, 7)),
              },
            },
            spec: {
              terminationGracePeriodSeconds: 30,
              containers: [
                {
                  name: appSlug,
                  image: release.image,
                  imagePullPolicy: 'IfNotPresent',
                  ports: [
                    {
                      containerPort: portNumber,
                      name: 'http',
                    },
                  ],
                  env: envList,
                  resources: {
                    requests: {
                      cpu: '100m',
                      memory: '128Mi',
                    },
                    limits: {
                      cpu: '500m',
                      memory: '256Mi',
                    },
                  },
                  lifecycle: {
                    preStop: {
                      exec: {
                        command: ['/bin/sh', '-c', 'sleep 3'],
                      },
                    },
                  },
                  readinessProbe: {
                    httpGet: {
                      path: '/health',
                      port: portNumber,
                    },
                    initialDelaySeconds: 2,
                    periodSeconds: 2,
                    timeoutSeconds: 2,
                    failureThreshold: 3,
                  },
                  livenessProbe: {
                    httpGet: {
                      path: '/health',
                      port: portNumber,
                    },
                    initialDelaySeconds: 5,
                    periodSeconds: 5,
                    timeoutSeconds: 2,
                    failureThreshold: 3,
                  },
                },
              ],
            },
          },
        },
      };

      // 6. Construct Service manifest (ClusterIP, 80 -> portNumber)
      const serviceManifest = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: appSlug,
          namespace,
          labels: {
            app: appSlug,
          },
        },
        spec: {
          type: 'ClusterIP',
          selector: {
            app: appSlug,
          },
          ports: [
            {
              name: 'http',
              port: 80,
              targetPort: portNumber,
            },
          ],
        },
      };

      // 7. Construct Ingress manifest (TLS with pushr-selfsigned-issuer)
      const host = `${appSlug}.pushr.localhost`;
      const ingressManifest = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: {
          name: appSlug,
          namespace,
          annotations: {
            'cert-manager.io/cluster-issuer': 'pushr-selfsigned-issuer',
            'ingress.class': 'traefik',
          },
          labels: {
            app: appSlug,
          },
        },
        spec: {
          tls: [
            {
              hosts: [host],
              secretName: `${appSlug}-tls`,
            },
          ],
          rules: [
            {
              host,
              http: {
                paths: [
                  {
                    path: '/',
                    pathType: 'Prefix',
                    backend: {
                      service: {
                        name: appSlug,
                        port: {
                          number: 80,
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      };

      const coreApi = await getCoreApi();
      const appsApi = await getAppsApi();
      const networkingApi = await getNetworkingApi();

      // 8. Idempotent Apply Service
      try {
        const existingSvc = await coreApi.readNamespacedService({ name: appSlug, namespace });
        const existingBody = existingSvc.body || existingSvc;
        serviceManifest.spec.clusterIP = existingBody.spec.clusterIP;
        serviceManifest.metadata.resourceVersion = existingBody.metadata.resourceVersion;
        await coreApi.replaceNamespacedService({ name: appSlug, namespace, body: serviceManifest });
        onLog(`[Pushr Deployer] Updated Service '${appSlug}'.\n`);
      } catch (err) {
        if (isNotFoundError(err)) {
          await coreApi.createNamespacedService({ namespace, body: serviceManifest });
          onLog(`[Pushr Deployer] Created Service '${appSlug}'.\n`);
        } else {
          throw err;
        }
      }

      // 9. Idempotent Apply Deployment
      try {
        const existingDep = await appsApi.readNamespacedDeployment({ name: appSlug, namespace });
        const existingBody = existingDep.body || existingDep;
        deploymentManifest.metadata.resourceVersion = existingBody.metadata.resourceVersion;
        await appsApi.replaceNamespacedDeployment({ name: appSlug, namespace, body: deploymentManifest });
        onLog(`[Pushr Deployer] Updated Deployment '${appSlug}' (image: ${release.image}).\n`);
      } catch (err) {
        if (isNotFoundError(err)) {
          await appsApi.createNamespacedDeployment({ namespace, body: deploymentManifest });
          onLog(`[Pushr Deployer] Created Deployment '${appSlug}' (image: ${release.image}).\n`);
        } else {
          throw err;
        }
      }

      // 10. Idempotent Apply Ingress
      try {
        const existingIng = await networkingApi.readNamespacedIngress({ name: appSlug, namespace });
        const existingBody = existingIng.body || existingIng;
        ingressManifest.metadata.resourceVersion = existingBody.metadata.resourceVersion;
        await networkingApi.replaceNamespacedIngress({ name: appSlug, namespace, body: ingressManifest });
        onLog(`[Pushr Deployer] Updated Ingress '${appSlug}'.\n`);
      } catch (err) {
        if (isNotFoundError(err)) {
          await networkingApi.createNamespacedIngress({ namespace, body: ingressManifest });
          onLog(`[Pushr Deployer] Created Ingress '${appSlug}'.\n`);
        } else {
          throw err;
        }
      }

      // 11. Watch Rollout Status (equivalent to kubectl rollout status)
      onLog(`[Pushr Deployer] Watching rollout for '${appSlug}' (timeout ${timeoutMs / 1000}s)...\n`);
      const startTime = Date.now();
      let rolloutSuccess = false;
      let failureReason = null;

      while (Date.now() - startTime < timeoutMs) {
        await new Promise((r) => setTimeout(r, 2000));
        const depRes = await appsApi.readNamespacedDeployment({ name: appSlug, namespace });
        const dep = depRes.body || depRes;

        const generation = dep.metadata?.generation || 1;
        const observedGeneration = dep.status?.observedGeneration || 0;
        const replicas = dep.spec?.replicas || 2;
        const updatedReplicas = dep.status?.updatedReplicas || 0;
        const readyReplicas = dep.status?.readyReplicas || 0;
        const availableReplicas = dep.status?.availableReplicas || 0;

        // Check if rollout completed successfully
        if (
          observedGeneration >= generation &&
          updatedReplicas === replicas &&
          readyReplicas === replicas &&
          availableReplicas === replicas
        ) {
          rolloutSuccess = true;
          break;
        }

        // Check conditions for explicit failures
        const conditions = dep.status?.conditions || [];
        const progressingCond = conditions.find((c) => c.type === 'Progressing');
        if (progressingCond && progressingCond.status === 'False' && progressingCond.reason === 'ProgressDeadlineExceeded') {
          failureReason = `ProgressDeadlineExceeded: ${progressingCond.message}`;
          break;
        }

        // Check for crashing pods in the new replicaset
        try {
          const podsRes = await coreApi.listNamespacedPod({
            namespace,
            labelSelector: `app=${appSlug}`,
          });
          const pods = podsRes.body?.items || podsRes.items || [];
          for (const pod of pods) {
            const statuses = pod.status?.containerStatuses || [];
            for (const s of statuses) {
              if (s.state?.waiting && s.state.waiting.reason === 'CrashLoopBackOff') {
                failureReason = `Pod ${pod.metadata.name} entered CrashLoopBackOff: ${s.state.waiting.message || ''}`;
                break;
              }
            }
            if (failureReason) break;
          }
          if (failureReason) break;
        } catch (_) {}
      }

      if (!rolloutSuccess) {
        const errMessage = failureReason || `Rollout timed out after ${timeoutMs / 1000}s. New pods failed readiness probe.`;
        throw new Error(errMessage);
      }

      // 12. Record successful deployment
      const deployedAt = new Date();
      release.deployStatus = 'deployed';
      release.deployedAt = deployedAt;
      release.deployError = null;
      await release.save();

      app.currentRelease = release._id;
      app.deployStatus = 'deployed';
      app.deployedAt = deployedAt;
      await app.save();

      onLog(`[Pushr Deployer] Rollout successful! App live at https://${host}\n`);

      return {
        status: 'deployed',
        appSlug,
        releaseId: release._id,
        url: `https://${host}`,
        deployedAt,
      };
    } catch (err) {
      onLog(`[Pushr Deployer ERROR] Deployment failed: ${err.message}\n`);
      release.deployStatus = 'failed';
      release.deployError = err.message;
      await release.save();

      app.deployStatus = 'failed';
      await app.save();

      throw err;
    }
  }
}

const deployer = new Deployer();
module.exports = deployer;
