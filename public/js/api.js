'use strict';

/* Thin fetch wrapper around the blackbox-ui REST API. */
const API = (() => {
  async function request(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let body = null;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: text };
    }
    if (!res.ok) {
      const err = new Error(body?.error || `${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  return {
    schema: () => request('/api/schema'),
    status: () => request('/api/status'),
    getConfig: () => request('/api/config'),
    saveConfig: (raw, baseMtime, { force = false, reload = true } = {}) =>
      request('/api/config', { method: 'PUT', body: JSON.stringify({ raw, baseMtime, force, reload }) }),
    validate: (raw) => request('/api/validate', { method: 'POST', body: JSON.stringify({ raw }) }),
    reload: () => request('/api/reload', { method: 'POST' }),
    backups: () => request('/api/backups'),
    backup: (name) => request(`/api/backups/${encodeURIComponent(name)}`),
    restoreBackup: (name) => request(`/api/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' }),
    probe: (module, target) =>
      request(`/api/probe?module=${encodeURIComponent(module)}&target=${encodeURIComponent(target)}`),
  };
})();
