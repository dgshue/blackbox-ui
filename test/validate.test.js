'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { validateRaw } = require('../server/validate');

const VALID = `modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      method: GET
      valid_status_codes: [200, 204]
      fail_if_header_matches:
        - header: Location
          regexp: ".*example.*"
      tls_config:
        insecure_skip_verify: true
  ping:
    prober: icmp
    icmp:
      preferred_ip_protocol: ip4
`;

test('valid config produces no errors', () => {
  const res = validateRaw(VALID);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.warnings, []);
});

test('YAML syntax errors are reported with a line number', () => {
  const res = validateRaw('modules:\n  foo: [unclosed\n');
  assert.equal(res.ok, false);
  assert.ok(res.syntax);
  assert.ok(Number.isInteger(res.syntax.line));
});

test('unknown prober is an error', () => {
  const res = validateRaw('modules:\n  m:\n    prober: telnet\n');
  assert.equal(res.ok, false);
  assert.match(res.errors[0].msg, /unknown prober/);
});

test('missing prober is an error', () => {
  const res = validateRaw('modules:\n  m:\n    timeout: 5s\n');
  assert.equal(res.ok, false);
});

test('unknown options produce warnings, not errors', () => {
  const res = validateRaw('modules:\n  m:\n    prober: http\n    http:\n      methodd: GET\n');
  assert.equal(res.ok, true);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0].path, /methodd/);
});

test('mismatched prober section warns', () => {
  const res = validateRaw('modules:\n  m:\n    prober: tcp\n    http:\n      method: GET\n');
  assert.equal(res.ok, true);
  assert.match(res.warnings[0].msg, /ignored/);
});

test('unitless timeout warns', () => {
  const res = validateRaw('modules:\n  m:\n    prober: http\n    timeout: 5\n');
  assert.equal(res.ok, true);
  assert.match(res.warnings[0].msg, /unit/);
});

test('missing required dns query_name warns', () => {
  const res = validateRaw('modules:\n  m:\n    prober: dns\n');
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => w.path.includes('query_name')));
});

test('non-mapping root is an error', () => {
  const res = validateRaw('- just\n- a\n- list\n');
  assert.equal(res.ok, false);
});
