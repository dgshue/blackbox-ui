'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.CONFIG_PATH || '/config/blackbox.yml';
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(CONFIG_PATH), '.backups');
const BACKUP_KEEP = Math.max(0, parseInt(process.env.BACKUP_KEEP || '20', 10) || 20);
const SEED_DEFAULT_CONFIG = (process.env.SEED_DEFAULT_CONFIG || 'true') !== 'false';

const BACKUP_NAME_RE = /^blackbox-\d{8}-\d{6}-\d{3}\.yml$/;

const DEFAULT_CONFIG = `# Blackbox Exporter configuration
# Managed by blackbox-ui (https://github.com/dgshue/blackbox-ui)
#
# Reference: https://github.com/prometheus/blackbox_exporter/blob/master/CONFIGURATION.md
modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      preferred_ip_protocol: ip4
  http_post_2xx:
    prober: http
    timeout: 5s
    http:
      method: POST
      preferred_ip_protocol: ip4
  tcp_connect:
    prober: tcp
    timeout: 5s
  icmp:
    prober: icmp
    timeout: 5s
    icmp:
      preferred_ip_protocol: ip4
  dns_a:
    prober: dns
    timeout: 5s
    dns:
      query_name: example.com
      query_type: A
`;

function configPath() {
  return CONFIG_PATH;
}

function seedIfMissing() {
  if (!SEED_DEFAULT_CONFIG) return false;
  if (fs.existsSync(CONFIG_PATH)) return false;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, DEFAULT_CONFIG, { encoding: 'utf8', mode: 0o644 });
  return true;
}

function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const st = fs.statSync(CONFIG_PATH);
  return { raw, mtime: Math.round(st.mtimeMs), path: CONFIG_PATH };
}

function statConfig() {
  try {
    const st = fs.statSync(CONFIG_PATH);
    return { exists: true, mtime: Math.round(st.mtimeMs), size: st.size, path: CONFIG_PATH };
  } catch {
    return { exists: false, path: CONFIG_PATH };
  }
}

function timestampName() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `blackbox-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}.yml`
  );
}

function pruneBackups() {
  const entries = listBackups();
  for (const entry of entries.slice(BACKUP_KEEP)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, entry.name));
    } catch {
      /* best effort */
    }
  }
}

function backupCurrent() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = timestampName();
  fs.copyFileSync(CONFIG_PATH, path.join(BACKUP_DIR, name));
  pruneBackups();
  return name;
}

function writeConfig(raw) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const backup = backupCurrent();
  // Atomic-ish replace so blackbox never sees a partially written file.
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, raw, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tmp, CONFIG_PATH);
  const st = fs.statSync(CONFIG_PATH);
  return { backup, mtime: Math.round(st.mtimeMs) };
}

function listBackups() {
  let names;
  try {
    names = fs.readdirSync(BACKUP_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => BACKUP_NAME_RE.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, mtime: Math.round(st.mtimeMs), size: st.size };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function readBackup(name) {
  if (!BACKUP_NAME_RE.test(name)) {
    const err = new Error('invalid backup name');
    err.status = 400;
    throw err;
  }
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) {
    const err = new Error('backup not found');
    err.status = 404;
    throw err;
  }
  return fs.readFileSync(file, 'utf8');
}

function restoreBackup(name) {
  const raw = readBackup(name);
  return { raw, ...writeConfig(raw) };
}

module.exports = {
  configPath,
  seedIfMissing,
  readConfig,
  statConfig,
  writeConfig,
  listBackups,
  readBackup,
  restoreBackup,
  DEFAULT_CONFIG,
};
