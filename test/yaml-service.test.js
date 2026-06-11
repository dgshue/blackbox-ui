'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbui-test-'));
process.env.CONFIG_PATH = path.join(dir, 'blackbox.yml');
process.env.BACKUP_KEEP = '3';

const { test } = require('node:test');
const assert = require('node:assert');
const svc = require('../server/yaml-service');

test('seeds a default config when missing', () => {
  assert.equal(svc.seedIfMissing(), true);
  assert.equal(svc.seedIfMissing(), false); // already exists
  const { raw } = svc.readConfig();
  assert.match(raw, /modules:/);
  assert.match(raw, /http_2xx:/);
});

test('writing takes a backup of the previous file', () => {
  const before = svc.readConfig().raw;
  const { backup } = svc.writeConfig('modules: {}\n');
  assert.ok(backup, 'backup name returned');
  assert.equal(svc.readConfig().raw, 'modules: {}\n');
  assert.equal(svc.readBackup(backup), before);
});

test('restore brings back the old content and backs up the current one', () => {
  const backups = svc.listBackups();
  const target = backups[0].name;
  const expected = svc.readBackup(target);
  svc.restoreBackup(target);
  assert.equal(svc.readConfig().raw, expected);
});

test('backups are pruned to BACKUP_KEEP', () => {
  for (let i = 0; i < 6; i++) svc.writeConfig(`modules: {} # rev ${i}\n`);
  assert.ok(svc.listBackups().length <= 3);
});

test('backup names are validated against traversal', () => {
  assert.throws(() => svc.readBackup('../../etc/passwd'), /invalid backup name/);
});
