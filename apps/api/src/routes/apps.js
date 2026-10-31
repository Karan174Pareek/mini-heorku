const express = require('express');
const router = express.Router();
const App = require('../models/App');
const Release = require('../models/Release');
const { getAppsApi } = require('../services/k8s');

/**
 * GET /api/apps/:slug
 * Retrieves app details including current release and deployment status.
 */
router.get('/:slug', async (req, res) => {
  try {
    const app = await App.findOne({ slug: req.params.slug }).populate('currentRelease');
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }
    res.json({
      slug: app.slug,
      currentRelease: app.currentRelease,
      deployStatus: app.deployStatus,
      deployedAt: app.deployedAt,
      url: `https://${app.slug}.pushr.localhost`,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/apps/:slug/status
 * Queries live Kubernetes Deployment status for the app.
 */
router.get('/:slug/status', async (req, res) => {
  try {
    const appSlug = req.params.slug;
    const namespace = `apps-${appSlug}`;
    const appsApi = await getAppsApi();

    let deployment = null;
    try {
      const depRes = await appsApi.readNamespacedDeployment({ name: appSlug, namespace });
      deployment = depRes.body || depRes;
    } catch (err) {
      if (err?.response?.statusCode === 404 || err?.statusCode === 404) {
        return res.status(404).json({ error: `Deployment '${appSlug}' not found in namespace '${namespace}'` });
      }
      throw err;
    }

    res.json({
      appSlug,
      namespace,
      replicas: deployment.spec?.replicas || 0,
      updatedReplicas: deployment.status?.updatedReplicas || 0,
      readyReplicas: deployment.status?.readyReplicas || 0,
      availableReplicas: deployment.status?.availableReplicas || 0,
      conditions: deployment.status?.conditions || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
