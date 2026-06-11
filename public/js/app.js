'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    schema: null,
    doc: null,            // parsed config (source of truth for the builder)
    baseMtime: null,      // mtime of the file as loaded, for conflict detection
    mode: 'form',
    selected: null,
    dirty: false,
    formMutated: false,   // builder changed state.doc since the editor text was last synced
    readOnly: false,
    suppressCm: false,
    testTargets: {},
  };

  let cm = null;

  /* ---------------- helpers ---------------- */

  const dump = () => jsyaml.dump(state.doc ?? {}, { lineWidth: 120, noRefs: true });

  function toast(msg, type = 'info', ms = 5000) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    $('toasts').append(el);
    setTimeout(() => el.remove(), ms);
  }

  function confirmDialog(title, text, okLabel = 'Confirm') {
    return new Promise((resolve) => {
      $('confirm-title').textContent = title;
      $('confirm-text').textContent = text;
      $('confirm-ok').textContent = okLabel;
      const dlg = $('modal-confirm');
      dlg.returnValue = 'cancel';
      dlg.onclose = () => resolve(dlg.returnValue === 'ok');
      dlg.showModal();
    });
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleString();
  }

  function markDirty(fromForm) {
    state.dirty = true;
    if (fromForm) state.formMutated = true;
    $('pill-dirty').classList.remove('hidden');
  }

  function clearDirty() {
    state.dirty = false;
    state.formMutated = false;
    $('pill-dirty').classList.add('hidden');
  }

  function currentRaw() {
    if (state.mode === 'form' && state.formMutated) return dump();
    return cm.getValue();
  }

  function setEditorValue(text) {
    state.suppressCm = true;
    cm.setValue(text);
    state.suppressCm = false;
  }

  /* ---------------- issues panel ---------------- */

  function showIssues(errors = [], warnings = [], title = 'Validation results') {
    const list = $('issues-list');
    list.textContent = '';
    for (const e of errors) {
      const li = document.createElement('li');
      li.className = 'issue issue-error';
      li.textContent = `${e.path ? e.path + ' — ' : ''}${e.msg}`;
      list.append(li);
    }
    for (const w of warnings) {
      const li = document.createElement('li');
      li.className = 'issue issue-warn';
      li.textContent = `${w.path ? w.path + ' — ' : ''}${w.msg}`;
      list.append(li);
    }
    $('issues-title').textContent = title;
    $('issues').classList.toggle('hidden', errors.length + warnings.length === 0);
  }

  function hideIssues() {
    $('issues').classList.add('hidden');
  }

  /* ---------------- module list / editor ---------------- */

  function moduleNames() {
    return state.doc && state.doc.modules ? Object.keys(state.doc.modules) : [];
  }

  function renderModuleList() {
    const ul = $('module-list');
    ul.textContent = '';
    const names = moduleNames();
    if (names.length === 0) {
      const li = document.createElement('li');
      li.className = 'module-empty muted';
      li.textContent = 'No modules yet — add one.';
      ul.append(li);
    }
    for (const name of names) {
      const mod = state.doc.modules[name];
      const li = document.createElement('li');
      li.className = `module-item${name === state.selected ? ' active' : ''}`;
      const label = document.createElement('span');
      label.className = 'module-name';
      label.textContent = name;
      const badge = document.createElement('span');
      const prober = mod && typeof mod === 'object' ? mod.prober : '?';
      badge.className = `badge badge-${prober || 'none'}`;
      badge.textContent = prober || '?';
      li.append(label, badge);
      li.addEventListener('click', () => selectModule(name));
      ul.append(li);
    }
  }

  function renderEditor() {
    const host = $('module-editor');
    host.textContent = '';
    if (!state.selected || !state.doc?.modules?.[state.selected]) {
      host.append(Object.assign(document.createElement('p'), {
        className: 'muted empty-hint',
        textContent: 'Select a module on the left, or add a new one to get started.',
      }));
      $('test-panel').classList.add('hidden');
      return;
    }

    const name = state.selected;
    const head = document.createElement('div');
    head.className = 'editor-head';
    head.innerHTML = `<h2 class="mono"></h2><span class="spacer"></span>`;
    head.querySelector('h2').textContent = name;
    const mkBtn = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = `btn btn-small ${cls || ''}`;
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    head.append(
      mkBtn('Rename', '', () => openModuleModal('rename', name)),
      mkBtn('Duplicate', '', () => duplicateModule(name)),
      mkBtn('Delete', 'btn-danger', () => deleteModule(name)),
    );
    host.append(head);

    const formHost = document.createElement('div');
    host.append(formHost);
    Forms.renderModuleForm(formHost, {
      doc: state.doc,
      name,
      onChange: () => { markDirty(true); },
      onProberChange: () => { renderModuleList(); renderEditor(); },
    });

    // test panel
    const mod = state.doc.modules[name];
    const probe = state.schema.probes[mod?.prober];
    $('test-panel').classList.remove('hidden');
    $('test-target').placeholder = probe?.targetHint || 'target';
    $('test-target').value = state.testTargets[name] || '';
    $('test-result').classList.add('hidden');
  }

  function selectModule(name) {
    state.selected = name;
    renderModuleList();
    renderEditor();
  }

  /* ---------------- module CRUD ---------------- */

  function uniqueName(base) {
    let candidate = base;
    let i = 2;
    while (state.doc.modules[candidate] !== undefined) candidate = `${base}_${i++}`;
    return candidate;
  }

  function openModuleModal(kind, currentName = null) {
    const dlg = $('modal-add');
    const isRename = kind === 'rename';
    $('modal-add-title').textContent = isRename ? `Rename ${currentName}` : 'Add module';
    $('add-submit').textContent = isRename ? 'Rename' : 'Add';
    $('add-name').value = isRename ? currentName : '';
    $('add-prober-wrap').classList.toggle('hidden', isRename);
    $('add-error').classList.add('hidden');

    if (!isRename) {
      const sel = $('add-prober');
      sel.textContent = '';
      for (const [p, spec] of Object.entries(state.schema.probes)) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = `${p} — ${spec.label}`;
        sel.append(opt);
      }
      const updateDesc = () => {
        $('add-prober-desc').textContent = state.schema.probes[sel.value]?.description || '';
      };
      sel.onchange = updateDesc;
      updateDesc();
    }

    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return;
      const name = $('add-name').value.trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) return;
      if (!state.doc) state.doc = {};
      if (!state.doc.modules || typeof state.doc.modules !== 'object') state.doc.modules = {};

      if (isRename) {
        if (name === currentName) return;
        if (state.doc.modules[name] !== undefined) {
          toast(`A module named "${name}" already exists`, 'error');
          return;
        }
        const rebuilt = {};
        for (const [k, v] of Object.entries(state.doc.modules)) {
          rebuilt[k === currentName ? name : k] = v;
        }
        state.doc.modules = rebuilt;
        state.selected = name;
      } else {
        if (state.doc.modules[name] !== undefined) {
          toast(`A module named "${name}" already exists`, 'error');
          return;
        }
        const prober = $('add-prober').value;
        const template = Forms.clone(state.schema.probes[prober]?.template) || {};
        state.doc.modules[name] = { prober, ...template };
        state.selected = name;
      }
      markDirty(true);
      renderModuleList();
      renderEditor();
    };
    dlg.showModal();
  }

  function duplicateModule(name) {
    const copy = Forms.clone(state.doc.modules[name]);
    const newName = uniqueName(`${name}_copy`);
    state.doc.modules[newName] = copy;
    markDirty(true);
    selectModule(newName);
  }

  async function deleteModule(name) {
    const ok = await confirmDialog('Delete module', `Delete module "${name}"? This takes effect when you save.`, 'Delete');
    if (!ok) return;
    delete state.doc.modules[name];
    markDirty(true);
    const names = moduleNames();
    state.selected = names[0] || null;
    renderModuleList();
    renderEditor();
  }

  /* ---------------- tabs ---------------- */

  function switchMode(mode) {
    if (mode === state.mode) return;
    if (mode === 'yaml') {
      if (state.formMutated) {
        setEditorValue(dump());
        state.formMutated = false;
      }
      state.mode = 'yaml';
    } else {
      try {
        const doc = jsyaml.load(cm.getValue());
        state.doc = doc && typeof doc === 'object' ? doc : { modules: {} };
        if (!state.doc.modules || typeof state.doc.modules !== 'object') state.doc.modules = state.doc.modules ?? {};
      } catch (e) {
        toast(`Cannot switch to builder: YAML has a syntax error (line ${e.mark ? e.mark.line + 1 : '?'})`, 'error');
        return;
      }
      state.mode = 'form';
      if (!state.selected || !state.doc.modules?.[state.selected]) {
        state.selected = moduleNames()[0] || null;
      }
      renderModuleList();
      renderEditor();
    }
    $('tab-form').classList.toggle('active', state.mode === 'form');
    $('tab-yaml').classList.toggle('active', state.mode === 'yaml');
    $('view-form').classList.toggle('hidden', state.mode !== 'form');
    $('view-yaml').classList.toggle('hidden', state.mode !== 'yaml');
    if (state.mode === 'yaml') cm.refresh();
  }

  /* ---------------- save / validate / backups ---------------- */

  async function save(force = false) {
    if (state.readOnly) return toast('Read-only mode — saving is disabled', 'error');
    const raw = currentRaw();
    try {
      const res = await API.saveConfig(raw, state.baseMtime, { force });
      state.baseMtime = res.mtime;
      setEditorValue(raw.endsWith('\n') ? raw : raw + '\n');
      clearDirty();
      if (res.warnings?.length) showIssues([], res.warnings, 'Saved with warnings');
      else hideIssues();
      if (res.reload?.ok) {
        toast('Saved — blackbox exporter reloaded ✓', 'success');
      } else if (res.reload) {
        showIssues([{ path: 'reload', msg: res.reload.message }], res.warnings || [], 'Saved, but reload failed');
        toast('Saved, but blackbox reload failed — see details', 'error', 8000);
      } else {
        toast('Saved', 'success');
      }
    } catch (e) {
      if (e.status === 409) {
        const ok = await confirmDialog(
          'Config changed on disk',
          'The file was modified outside this session since you loaded it. Overwrite it with your version? (A backup of the on-disk file is taken first.)',
          'Overwrite');
        if (ok) return save(true);
        return;
      }
      if (e.body?.syntax) {
        showIssues([{ path: `line ${e.body.syntax.line ?? '?'}`, msg: e.body.syntax.msg }], [], 'YAML syntax error');
      } else if (e.body?.errors) {
        showIssues(e.body.errors, e.body.warnings || [], 'Configuration rejected');
      }
      toast(`Save failed: ${e.message}`, 'error', 8000);
    }
  }

  async function validateNow() {
    try {
      const res = await API.validate(currentRaw());
      if (res.errors.length === 0 && res.warnings.length === 0) {
        hideIssues();
        toast('No issues found ✓', 'success');
      } else {
        showIssues(res.errors, res.warnings);
      }
    } catch (e) {
      toast(`Validation failed: ${e.message}`, 'error');
    }
  }

  async function openBackups() {
    const dlg = $('modal-backups');
    const ul = $('backup-list');
    ul.textContent = '';
    try {
      const backups = await API.backups();
      if (backups.length === 0) {
        ul.innerHTML = '<li class="muted">No backups yet.</li>';
      }
      for (const b of backups) {
        const li = document.createElement('li');
        li.className = 'backup-item';
        const meta = document.createElement('span');
        meta.className = 'mono';
        meta.textContent = `${fmtTime(b.mtime)} · ${b.size} B`;
        const view = document.createElement('a');
        view.href = `/api/backups/${encodeURIComponent(b.name)}`;
        view.target = '_blank';
        view.textContent = 'view';
        const btn = document.createElement('button');
        btn.className = 'btn btn-small';
        btn.textContent = 'Restore';
        btn.addEventListener('click', async () => {
          dlg.close();
          const ok = await confirmDialog('Restore backup', `Restore the config from ${fmtTime(b.mtime)} and reload blackbox?`, 'Restore');
          if (!ok) return;
          try {
            const res = await API.restoreBackup(b.name);
            await loadConfig();
            toast(res.reload?.ok ? 'Backup restored — blackbox reloaded ✓' : `Restored, but reload failed: ${res.reload?.message}`, res.reload?.ok ? 'success' : 'error', 7000);
          } catch (e) {
            toast(`Restore failed: ${e.message}`, 'error');
          }
        });
        li.append(meta, view, btn);
        ul.append(li);
      }
    } catch (e) {
      ul.innerHTML = `<li class="issue issue-error">Failed to list backups: ${e.message}</li>`;
    }
    dlg.showModal();
  }

  /* ---------------- probe testing ---------------- */

  async function runTest() {
    const name = state.selected;
    const target = $('test-target').value.trim();
    if (!name) return;
    if (!target) return toast('Enter a target to probe', 'error');
    state.testTargets[name] = target;
    if (state.dirty) toast('Heads up: you have unsaved changes — the test uses the last saved config', 'info', 6000);

    const btn = $('btn-test');
    const out = $('test-result');
    btn.disabled = true;
    btn.textContent = 'Probing…';
    out.classList.add('hidden');
    try {
      const res = await API.probe(name, target);
      const text = res.text || '';
      const success = /\bprobe_success\s+1\b/.test(text);
      const durMatch = text.match(/\bprobe_duration_seconds\s+([0-9.eE+-]+)/);
      const duration = durMatch ? `${(parseFloat(durMatch[1]) * 1000).toFixed(0)} ms` : '';

      const iMetrics = text.indexOf('Metrics that would have been returned:');
      const iModule = text.indexOf('Module configuration:');
      const logs = iMetrics > -1 ? text.slice(0, iMetrics).trim() : text.trim();
      const metrics = iMetrics > -1 ? text.slice(iMetrics, iModule > -1 ? iModule : undefined).trim() : '';

      out.textContent = '';
      const badge = document.createElement('div');
      badge.className = `probe-badge ${success ? 'probe-ok' : 'probe-fail'}`;
      badge.textContent = success ? `✓ Probe succeeded ${duration && '· ' + duration}` : `✗ Probe failed ${duration && '· ' + duration}`;
      out.append(badge);
      const mkDetails = (title, body, open) => {
        const d = document.createElement('details');
        if (open) d.open = true;
        const s = document.createElement('summary');
        s.textContent = title;
        const pre = document.createElement('pre');
        pre.textContent = body;
        d.append(s, pre);
        return d;
      };
      if (logs) out.append(mkDetails('Probe logs', logs, !success));
      if (metrics) out.append(mkDetails('Metrics', metrics, false));
      out.classList.remove('hidden');
    } catch (e) {
      out.textContent = '';
      const badge = document.createElement('div');
      badge.className = 'probe-badge probe-fail';
      badge.textContent = `✗ ${e.message}`;
      out.append(badge);
      out.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run probe';
    }
  }

  /* ---------------- status ---------------- */

  async function refreshStatus() {
    try {
      const st = await API.status();
      $('app-version').textContent = `v${st.app.version}`;
      $('config-path').textContent = st.config.path;
      state.readOnly = st.app.readOnly;
      $('btn-save').disabled = state.readOnly;

      const pill = $('pill-blackbox');
      pill.classList.remove('pill-ok', 'pill-bad');
      pill.classList.add(st.blackbox.up ? 'pill-ok' : 'pill-bad');
      pill.querySelector('.pill-text').textContent = st.blackbox.up
        ? `blackbox ${st.blackbox.version ? 'v' + st.blackbox.version : ''} up`
        : 'blackbox unreachable';

      if (st.blackbox.publicUrl) {
        const a = $('link-blackbox');
        a.href = st.blackbox.publicUrl;
        a.classList.remove('hidden');
      }
      if (state.readOnly) {
        const banner = $('banner');
        banner.textContent = 'Read-only mode — editing is disabled.';
        banner.classList.remove('hidden');
      }
    } catch {
      /* status is best-effort */
    }
  }

  /* ---------------- boot ---------------- */

  async function loadConfig() {
    const cfg = await API.getConfig();
    state.baseMtime = cfg.mtime;
    setEditorValue(cfg.raw);
    try {
      const doc = jsyaml.load(cfg.raw);
      state.doc = doc && typeof doc === 'object' ? doc : { modules: {} };
      if (!state.doc.modules) state.doc.modules = {};
      state.formMutated = false;
      clearDirty();
      if (!state.selected || !state.doc.modules[state.selected]) {
        state.selected = moduleNames()[0] || null;
      }
      renderModuleList();
      renderEditor();
    } catch (e) {
      state.doc = null;
      toast('Config has a YAML syntax error — opening in YAML mode', 'error', 8000);
      switchMode('yaml');
    }
  }

  async function boot() {
    cm = CodeMirror($('cm-host'), {
      value: '',
      mode: 'yaml',
      theme: 'default',
      lineNumbers: true,
      indentUnit: 2,
      tabSize: 2,
      lineWrapping: false,
    });
    cm.on('change', () => {
      if (state.suppressCm) return;
      markDirty(false);
      scheduleYamlCheck();
    });

    let checkTimer = null;
    const scheduleYamlCheck = () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => {
        const status = $('yaml-status');
        try {
          jsyaml.load(cm.getValue());
          status.textContent = '✓ valid YAML';
          status.className = 'yaml-status mono ok';
        } catch (e) {
          status.textContent = `✗ line ${e.mark ? e.mark.line + 1 : '?'}: ${e.reason || e.message}`;
          status.className = 'yaml-status mono bad';
        }
      }, 350);
    };

    state.schema = await API.schema();
    Forms.init(state.schema);
    $('link-docs').href = state.schema.docsUrl;

    $('tab-form').addEventListener('click', () => switchMode('form'));
    $('tab-yaml').addEventListener('click', () => switchMode('yaml'));
    $('btn-save').addEventListener('click', () => save());
    $('btn-validate').addEventListener('click', validateNow);
    $('btn-backups').addEventListener('click', openBackups);
    $('backups-close').addEventListener('click', () => $('modal-backups').close());
    $('btn-add-module').addEventListener('click', () => openModuleModal('add'));
    $('btn-test').addEventListener('click', runTest);
    $('test-target').addEventListener('keydown', (e) => { if (e.key === 'Enter') runTest(); });
    $('issues-close').addEventListener('click', hideIssues);

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    try {
      await loadConfig();
    } catch (e) {
      $('banner').textContent = `Could not load config: ${e.message}`;
      $('banner').classList.remove('hidden');
    }
    refreshStatus();
    setInterval(refreshStatus, 10000);
  }

  boot();
})();
