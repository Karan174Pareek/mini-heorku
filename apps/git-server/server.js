const express = require('express');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = express();
const port = process.env.PORT || 8080;
const reposDir = process.env.REPOS_PATH || '/repos';
const apiInternalUrl = process.env.API_INTERNAL_URL || 'http://host.k3d.internal:3000';
const internalSecret = process.env.PUSHR_INTERNAL_SECRET || 'pushr_internal_shared_secret_2026';

// Middleware for parsing json on internal endpoints
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pushr-git-server' });
});

// Guard internal routes: must NOT be accessible via Ingress and must have internal secret
function guardInternal(req, res, next) {
  const isFromIngress = req.headers['x-forwarded-host'] === 'git.pushr.localhost' ||
                        req.headers['x-forwarded-proto'] !== undefined ||
                        (req.headers['host'] && req.headers['host'].includes('git.pushr.localhost'));

  if (isFromIngress) {
    return res.status(404).json({ error: 'Not found' });
  }

  const providedSecret = req.headers['x-pushr-internal-secret'];
  if (!providedSecret || providedSecret !== internalSecret) {
    return res.status(403).json({ error: 'Forbidden: invalid or missing internal secret' });
  }

  next();
}

// Internal endpoint: initialize bare repo
app.post('/internal/repos/:slug', guardInternal, (req, res) => {
  const slug = req.params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Valid slug required' });
  }

  const scriptPath = path.join(__dirname, 'init-repo.sh');
  execFile('/bin/sh', [scriptPath, slug], (err, stdout, stderr) => {
    if (err) {
      console.error(`init-repo error for ${slug}:`, stderr || err.message);
      return res.status(500).json({ error: err.message, stderr });
    }
    res.status(201).json({ message: 'Repository initialized', slug, output: stdout });
  });
});

// Internal endpoint: stream git archive for a commit SHA
app.get('/internal/repos/:slug/archive/:sha', guardInternal, (req, res) => {
  const { slug, sha } = req.params;
  const repoDir = path.join(reposDir, `${slug}.git`);

  if (!fs.existsSync(repoDir)) {
    return res.status(404).json({ error: `Repository for '${slug}' not found` });
  }

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-${sha}.tar.gz"`);

  const gitArchive = spawn('git', [`--git-dir=${repoDir}`, 'archive', '--format=tar.gz', sha]);
  gitArchive.stdout.pipe(res);

  gitArchive.stderr.on('data', (d) => {
    console.error(`git archive error for ${slug}@${sha}:`, d.toString());
  });

  gitArchive.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  });
});

// Git Smart HTTP Authentication Helper
async function verifyPushToken(slug, token) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ slug, token });
    const url = new URL(`${apiInternalUrl}/api/internal/auth/verify`);

    const clientReq = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Pushr-Internal-Secret': internalSecret,
      },
      timeout: 5000,
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        if (apiRes.statusCode === 200) {
          try {
            const body = JSON.parse(data);
            resolve(body.valid === true);
          } catch (_) {
            resolve(false);
          }
        } else {
          resolve(false);
        }
      });
    });

    clientReq.on('error', (err) => {
      console.error('Auth verification request error:', err.message);
      resolve(false);
    });

    clientReq.on('timeout', () => {
      clientReq.destroy();
      resolve(false);
    });

    clientReq.write(payload);
    clientReq.end();
  });
}

// Git Smart HTTP Handler (CGI bridge to git http-backend)
app.all(/^(\/([a-zA-Z0-9_-]+)\.git)(.*)/, async (req, res) => {
  const fullPath = req.url;
  const slug = req.params[1];
  const repoDir = path.join(reposDir, `${slug}.git`);

  // 1. Check HTTP Basic Authentication
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Pushr Git"');
    return res.status(401).send('Unauthorized: Push token required\n');
  }

  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const colonIndex = credentials.indexOf(':');
  const username = colonIndex !== -1 ? credentials.slice(0, colonIndex) : 'git';
  const token = colonIndex !== -1 ? credentials.slice(colonIndex + 1) : credentials;

  const isValid = await verifyPushToken(slug, token);
  if (!isValid) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Pushr Git"');
    return res.status(401).send('Unauthorized: Invalid push token\n');
  }

  // 2. Ensure repository exists
  if (!fs.existsSync(repoDir)) {
    return res.status(404).send(`Repository '${slug}.git' not found. Create the app first via Pushr API.\n`);
  }

  // 3. Execute git http-backend
  const gitBackendBin = fs.existsSync('/usr/libexec/git-core/git-http-backend')
    ? '/usr/libexec/git-core/git-http-backend'
    : '/usr/lib/git-core/git-http-backend';

  const backend = spawn(gitBackendBin, [], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: reposDir,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: req.path,
      QUERY_STRING: req.url.includes('?') ? req.url.split('?')[1] : '',
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] || '',
      REMOTE_USER: username,
      REMOTE_ADDR: req.ip || '127.0.0.1',
      GIT_COMMITTER_NAME: username,
      GIT_COMMITTER_EMAIL: `${username}@pushr.local`,
    },
  });

  req.pipe(backend.stdin);

  let headerBuffer = Buffer.alloc(0);
  let headersSent = false;

  backend.stdout.on('data', (chunk) => {
    if (headersSent) {
      res.write(chunk);
      return;
    }

    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    const headerEndIndex = headerBuffer.indexOf('\r\n\r\n');
    const headerEndIndexLF = headerBuffer.indexOf('\n\n');
    const splitIndex = headerEndIndex !== -1 ? headerEndIndex : headerEndIndexLF;
    const delimiterLen = headerEndIndex !== -1 ? 4 : 2;

    if (splitIndex !== -1) {
      headersSent = true;
      const rawHeaders = headerBuffer.slice(0, splitIndex).toString('utf8');
      const body = headerBuffer.slice(splitIndex + delimiterLen);

      const headerLines = rawHeaders.split(/\r?\n/);
      for (const line of headerLines) {
        if (!line.trim()) continue;
        const cIdx = line.indexOf(':');
        if (cIdx === -1) continue;
        const key = line.slice(0, cIdx).trim();
        const val = line.slice(cIdx + 1).trim();

        if (key.toLowerCase() === 'status') {
          const statusNum = parseInt(val.split(' ')[0], 10);
          if (!isNaN(statusNum)) res.status(statusNum);
        } else {
          res.setHeader(key, val);
        }
      }

      if (body.length > 0) {
        res.write(body);
      }
    }
  });

  backend.stdout.on('end', () => {
    res.end();
  });

  backend.stderr.on('data', (d) => {
    console.error('[git-http-backend stderr]', d.toString());
  });

  backend.on('error', (err) => {
    console.error('[git-http-backend spawn error]', err);
    if (!res.headersSent) {
      res.status(500).send(err.message);
    }
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Pushr Git Server listening on port ${port}`);
});

