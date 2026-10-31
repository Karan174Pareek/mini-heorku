let k8sModule = null;
let kc = null;
let k8sBatchApi = null;
let k8sCoreApi = null;
let k8sAppsApi = null;
let k8sNetworkingApi = null;

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

async function getAppsApi() {
  if (!k8sAppsApi) {
    const k8s = await getK8s();
    const config = await getKubeConfig();
    k8sAppsApi = config.makeApiClient(k8s.AppsV1Api);
  }
  return k8sAppsApi;
}

async function getNetworkingApi() {
  if (!k8sNetworkingApi) {
    const k8s = await getK8s();
    const config = await getKubeConfig();
    k8sNetworkingApi = config.makeApiClient(k8s.NetworkingV1Api);
  }
  return k8sNetworkingApi;
}

function isNotFoundError(err) {
  if (!err) return false;
  if (err.statusCode === 404 || err.code === 404 || err.code === '404') return true;
  if (err.response?.statusCode === 404 || err.response?.status === 404) return true;
  if (err.body?.code === 404 || err.body?.reason === 'NotFound') return true;
  const msg = String(err.message || '');
  if (msg.includes('404') || msg.includes('NotFound') || msg.includes('not found')) return true;
  return false;
}

async function ensureNamespace(namespace = 'pushr-builds') {
  const coreApi = await getCoreApi();
  try {
    await coreApi.readNamespace({ name: namespace });
  } catch (err) {
    if (isNotFoundError(err)) {
      await coreApi.createNamespace({
        body: {
          metadata: { name: namespace }
        }
      });
    } else {
      throw err;
    }
  }
}

module.exports = {
  getKubeConfig,
  getBatchApi,
  getCoreApi,
  getAppsApi,
  getNetworkingApi,
  ensureNamespace,
  isNotFoundError,
};
