'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');

const pkg = require('../package.json');
const schema = require('../shared/schema.json');
const yamlService = require('./yaml-service');
const blackbox = require('./blackbox');
const { validateRaw } = require('./validate');

const PORT = parseInt(process.env.PORT || '8080', 10);
const READ_ONLY = (process.env.READ_ONLY || 'false') === 'true';
const AUTH_USER = process.env.BASIC_AUTH_USERNAME || '';
const AUTH_PASS = process.env.BASIC_AUTH_PASSWORD || '';
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

// Liveness for the container healthcheck — never behind auth.
app.get('/healthz', (req, res) => {
  const stat = yamlService.statConfig();
  if (!stat.exists) return res.status(503).json({ ok: false, error: 'config file missing' });
  res.json({ ok: true });
});

if (AUTH_USER && AUTH_PASS) {
  const expected = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`);
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, value] = header.split(' ');
    if (scheme === 'Basic' && value) {
      const given = Buffer.from(value, 'base64');
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
        return next();
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="blackbox-ui"');
    res.status(401).send('Authentication required');
  });
}

const guardWrites = (req, res, next) => {
  if (READ_ONLY) return res.status(403).json({ error: 'blackbox-ui is running in read-only mode' });
  next();
};

app.get('/api/schema', (req, res) => res.json(schema));

app.get('/api/status', async (req, res) => {
  const bb = await blackbox.status();
  res.json({
    app: { name: pkg.name, version: pkg.version, readOnly: READ_ONLY },
    config: yamlService.statConfig(),
    blackbox: { ...bb, publicUrl: process.env.PUBLIC_BLACKBOX_URL || null },
  });
});

app.get('/api/config', (req, res) => {
  const stat = yamlService.statConfig();
  if (!stat.exists) return res.status(404).json({ error: `config file not found at ${stat.path}` });
  res.json(yamlService.readConfig());
});

app.put('/api/config', guardWrites, async (req, res) => {
  const { raw, reload = true, baseMtime = null, force = false } = req.body || {};
  if (typeof raw !== 'string' || raw.trim() === '') {
    return res.status(400).json({ error: 'body must include a non-empty "raw" YAML string' });
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) {
    return res.status(413).json({ error: 'config exceeds 2MB limit' });
  }

  const result = validateRaw(raw);
  if (result.syntax) {
    return res.status(400).json({ error: 'YAML syntax error', syntax: result.syntax });
  }
  if (!result.ok) {
    return res.status(400).json({ error: 'invalid configuration', errors: result.errors, warnings: result.warnings });
  }

  // Optimistic concurrency: refuse to clobber a file modified since the client loaded it.
  const current = yamlService.statConfig();
  if (!force && baseMtime !== null && current.exists && Math.abs(current.mtime - baseMtime) > 1) {
    return res.status(409).json({ error: 'config changed on disk since it was loaded', mtime: current.mtime });
  }

  const ensureNewline = raw.endsWith('\n') ? raw : `${raw}\n`;
  const { backup, mtime } = yamlService.writeConfig(ensureNewline);
  const reloadResult = reload ? await blackbox.reload() : null;
  res.json({ ok: true, mtime, backup, warnings: result.warnings, reload: reloadResult });
});

app.post('/api/validate', (req, res) => {
  const { raw } = req.body || {};
  if (typeof raw !== 'string') {
    return res.status(400).json({ error: 'body must include a "raw" YAML string' });
  }
  res.json(validateRaw(raw));
});

app.post('/api/reload', guardWrites, async (req, res) => {
  res.json(await blackbox.reload());
});

app.get('/api/backups', (req, res) => res.json(yamlService.listBackups()));

app.get('/api/backups/:name', (req, res) => {
  res.json({ name: req.params.name, raw: yamlService.readBackup(req.params.name) });
});

app.post('/api/backups/:name/restore', guardWrites, async (req, res) => {
  const { mtime, backup } = yamlService.restoreBackup(req.params.name);
  const reloadResult = await blackbox.reload();
  res.json({ ok: true, mtime, backup, reload: reloadResult });
});

app.get('/api/probe', async (req, res) => {
  const { module: mod, target, hostname } = req.query;
  if (!mod || !target) return res.status(400).json({ error: '"module" and "target" query parameters are required' });
  try {
    const result = await blackbox.probe({ module: mod, target, hostname });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: `probe request failed: ${e.cause?.code || e.message}` });
  }
});

app.get('/api/blackbox/config', async (req, res, next) => {
  try {
    res.type('text/plain').send(await blackbox.loadedConfig());
  } catch (e) {
    next(e);
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor/codemirror', express.static(path.join(__dirname, '..', 'node_modules', 'codemirror')));
app.use('/vendor/js-yaml', express.static(path.join(__dirname, '..', 'node_modules', 'js-yaml', 'dist')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'internal error' });
});

if (require.main === module) {
  if (yamlService.seedIfMissing()) {
    console.log(`Seeded default config at ${yamlService.configPath()}`);
  }
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`blackbox-ui ${pkg.version} listening on :${PORT}`);
    console.log(`  config file:  ${yamlService.configPath()}`);
    console.log(`  blackbox url: ${blackbox.BLACKBOX_URL}`);
    if (READ_ONLY) console.log('  mode:         read-only');
  });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

module.exports = app;
