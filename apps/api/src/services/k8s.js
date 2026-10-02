let k8sModule = null;
let kc = null;
let k8sBatchApi = null;
let k8sCoreApi = null;

async function getK8s() {
  if (!k8sModule) {
    k8sModule = await import('@kubernetes/client-node');
  }
  return k8sModule;
}

async function getKubeConfig() {
  if (!kc) {
    const k8s = await getK8s();
    kc = new k8s.KubeConfig();
    try {
      kc.loadFromDefault();
    } catch (err) {
      console.warn('Warning: Could not load default kubeconfig:', err.message);
    }
  }
  return kc;
}

async function getBatchApi() {
  if (!k8sBatchApi) {
    const k8s = await getK8s();
    const config = await getKubeConfig();
    k8sBatchApi = config.makeApiClient(k8s.BatchV1Api);
  }
  return k8sBatchApi;
}

async function getCoreApi() {
  if (!k8sCoreApi) {
    const k8s = await getK8s();
    const config = await getKubeConfig();
    k8sCoreApi = config.makeApiClient(k8s.CoreV1Api);
  }
  return k8sCoreApi;
}

async function ensureNamespace(namespace = 'pushr-builds') {
  const coreApi = await getCoreApi();
  try {
    await coreApi.readNamespace({ name: namespace });
  } catch (err) {
    if (err?.response?.statusCode === 404 || err?.statusCode === 404) {
      await coreApi.createNamespace({
        body: {
          metadata: { name: namespace }
        }
      });
    }
  }
}

module.exports = {
  getKubeConfig,
  getBatchApi,
  getCoreApi,
  ensureNamespace,
};
