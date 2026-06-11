'use strict';

const BLACKBOX_URL = (process.env.BLACKBOX_URL || 'http://blackbox:9115').replace(/\/+$/, '');

async function request(pathname, { method = 'GET', timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${BLACKBOX_URL}${pathname}`, { method, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function reload() {
  try {
    const res = await request('/-/reload', { method: 'POST', timeoutMs: 10000 });
    const body = (await res.text()).trim();
    if (res.ok) {
      return { ok: true, message: 'Blackbox exporter reloaded' };
    }
    return { ok: false, status: res.status, message: body || `reload failed with status ${res.status}` };
  } catch (e) {
    return { ok: false, message: `blackbox exporter unreachable: ${e.cause?.code || e.message}` };
  }
}

async function status() {
  const result = { url: BLACKBOX_URL, up: false, version: null };
  try {
    let res = await request('/-/healthy');
    if (res.status === 404) res = await request('/');
    result.up = res.ok;
  } catch {
    return result;
  }
  try {
    const res = await request('/metrics');
    if (res.ok) {
      const text = await res.text();
      const m = text.match(/blackbox_exporter_build_info\{[^}]*version="([^"]*)"/);
      if (m) result.version = m[1];
    }
  } catch {
    /* version is optional */
  }
  return result;
}

async function loadedConfig() {
  const res = await request('/config');
  if (!res.ok) {
    const err = new Error(`blackbox /config returned ${res.status}`);
    err.status = 502;
    throw err;
  }
  return res.text();
}

async function probe({ module: mod, target, hostname }) {
  const params = new URLSearchParams({ module: mod, target, debug: 'true' });
  if (hostname) params.set('hostname', hostname);
  // Probes run up to the module timeout; allow plenty of headroom.
  const res = await request(`/probe?${params}`, { timeoutMs: 65000 });
  return { status: res.status, text: await res.text() };
}

module.exports = { reload, status, loadedConfig, probe, BLACKBOX_URL };
