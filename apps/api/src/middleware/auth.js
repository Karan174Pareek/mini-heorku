const crypto = require('crypto');

function requireInternalSecret(req, res, next) {
  const expectedSecret = process.env.PUSHR_INTERNAL_SECRET || 'pushr_internal_shared_secret_2026';
  const provided = req.headers['x-pushr-internal-secret'];
  if (!provided) {
    return res.status(401).json({ error: 'Unauthorized: missing internal secret header' });
  }

  const bufExpected = Buffer.from(expectedSecret);
  const bufProvided = Buffer.from(provided);
  if (bufExpected.length !== bufProvided.length || !crypto.timingSafeEqual(bufExpected, bufProvided)) {
    return res.status(403).json({ error: 'Forbidden: invalid internal secret' });
  }

  next();
}

module.exports = {
  requireInternalSecret,
};

