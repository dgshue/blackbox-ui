'use strict';

/*
 * Schema-driven form renderer.
 *
 * Renders editing controls for a blackbox module straight from
 * /api/schema (shared/schema.json) and mutates the parsed config
 * object in place. Empty values delete their keys and empty parent
 * objects are pruned, so the YAML that gets generated stays minimal.
 * Keys that the schema does not model are simply never touched, which
 * means hand-written YAML survives form edits.
 */
const Forms = (() => {
  let S = null; // schema, injected via init()
  let uid = 0;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    }
    for (const c of children) {
      if (c === undefined || c === null) continue;
      el.append(c);
    }
    return el;
  }

  function getIn(root, path) {
    return path.reduce((o, k) => (o == null ? undefined : o[k]), root);
  }

  function setIn(root, path, value) {
    let o = root;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (!isObj(o[k])) o[k] = {};
      o = o[k];
    }
    o[path[path.length - 1]] = value;
  }

  function deleteIn(root, path) {
    const parents = [];
    let o = root;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (!isObj(o[k])) return;
      parents.push([o, k]);
      o = o[k];
    }
    delete o[path[path.length - 1]];
    for (let i = parents.length - 1; i >= 0; i--) {
      const [parent, key] = parents[i];
      if (isObj(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
      else break;
    }
  }

  function resolveFields(spec) {
    if (spec.ref) return S.types[spec.ref]?.fields || {};
    return spec.fields || {};
  }

  /* ------------------------------------------------------------------ */

  function fieldShell(spec, control, { wide = false } = {}) {
    const label = h('div', { class: 'field-label' }, h('span', { text: spec.label || '' }));
    if (spec.default !== undefined) {
      label.append(h('span', { class: 'chip', text: `default: ${spec.default}` }));
    }
    const wrap = h('div', { class: `field${wide ? ' field-wide' : ''}` }, label, control);
    if (spec.help) wrap.append(h('div', { class: 'field-help', text: spec.help }));
    return wrap;
  }

  function bindText(input, root, path, onChange, transform = (v) => v) {
    input.addEventListener('input', () => {
      const v = input.value;
      if (v === '') deleteIn(root, path);
      else {
        const t = transform(v);
        if (t === undefined) return; // transform signals "invalid, don't write"
        setIn(root, path, t);
      }
      onChange();
    });
  }

  function renderField(spec, root, path, onChange) {
    const current = getIn(root, path);

    switch (spec.type) {
      case 'string': {
        if (spec.multiline) {
          const ta = h('textarea', { rows: 4, spellcheck: 'false', placeholder: spec.placeholder || '' });
          if (typeof current === 'string') ta.value = current;
          bindText(ta, root, path, onChange);
          return fieldShell(spec, ta, { wide: true });
        }
        const input = h('input', { type: 'text', spellcheck: 'false', placeholder: spec.placeholder || '' });
        if (current !== undefined) input.value = String(current);
        bindText(input, root, path, onChange);
        return fieldShell(spec, input);
      }

      case 'secret': {
        const input = h('input', { type: 'password', spellcheck: 'false', autocomplete: 'off' });
        if (current !== undefined) input.value = String(current);
        bindText(input, root, path, onChange);
        const toggle = h('button', {
          type: 'button', class: 'btn btn-ghost btn-small', text: 'show',
          onclick: () => {
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            toggle.textContent = showing ? 'show' : 'hide';
          },
        });
        return fieldShell(spec, h('div', { class: 'input-row' }, input, toggle));
      }

      case 'duration':
      case 'size': {
        const input = h('input', { type: 'text', spellcheck: 'false', placeholder: spec.placeholder || (spec.type === 'duration' ? '5s' : '10MB'), class: 'input-short' });
        if (current !== undefined) input.value = String(current);
        bindText(input, root, path, onChange);
        return fieldShell(spec, input);
      }

      case 'int': {
        const input = h('input', { type: 'number', step: '1', class: 'input-short' });
        if (current !== undefined) input.value = String(current);
        input.addEventListener('input', () => {
          if (input.value === '') deleteIn(root, path);
          else setIn(root, path, Math.trunc(Number(input.value)));
          onChange();
        });
        return fieldShell(spec, input);
      }

      case 'bool': {
        const sel = h('select', {},
          h('option', { value: '', text: spec.default !== undefined ? `(default: ${spec.default})` : '(unset)' }),
          h('option', { value: 'true', text: 'true' }),
          h('option', { value: 'false', text: 'false' }));
        if (current === true) sel.value = 'true';
        else if (current === false) sel.value = 'false';
        sel.addEventListener('change', () => {
          if (sel.value === '') deleteIn(root, path);
          else setIn(root, path, sel.value === 'true');
          onChange();
        });
        return fieldShell(spec, sel);
      }

      case 'enum': {
        if (spec.allowCustom) {
          const listId = `dl-${++uid}`;
          const input = h('input', { type: 'text', list: listId, spellcheck: 'false', placeholder: spec.default !== undefined ? `default: ${spec.default}` : '' });
          const dl = h('datalist', { id: listId }, ...spec.enum.map((v) => h('option', { value: v })));
          if (current !== undefined) input.value = String(current);
          bindText(input, root, path, onChange);
          return fieldShell(spec, h('div', {}, input, dl));
        }
        const sel = h('select', {},
          h('option', { value: '', text: spec.default !== undefined ? `(default: ${spec.default})` : '(unset)' }),
          ...spec.enum.map((v) => h('option', { value: v, text: v })));
        if (typeof current === 'string' && spec.enum.includes(current)) sel.value = current;
        sel.addEventListener('change', () => {
          if (sel.value === '') deleteIn(root, path);
          else setIn(root, path, sel.value);
          onChange();
        });
        return fieldShell(spec, sel);
      }

      case 'stringlist': {
        const ta = h('textarea', { rows: 3, spellcheck: 'false', placeholder: spec.placeholder || 'one entry per line' });
        if (Array.isArray(current)) ta.value = current.join('\n');
        ta.addEventListener('input', () => {
          const items = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
          if (items.length === 0) deleteIn(root, path);
          else setIn(root, path, items);
          onChange();
        });
        return fieldShell(spec, ta, { wide: true });
      }

      case 'intlist': {
        const input = h('input', { type: 'text', spellcheck: 'false', placeholder: spec.placeholder || 'e.g. 200, 204' });
        if (Array.isArray(current)) input.value = current.join(', ');
        input.addEventListener('input', () => {
          const tokens = input.value.split(/[\s,]+/).filter(Boolean);
          const nums = tokens.map(Number);
          const valid = nums.every(Number.isInteger);
          input.classList.toggle('input-error', !valid);
          if (!valid) return;
          if (nums.length === 0) deleteIn(root, path);
          else setIn(root, path, nums);
          onChange();
        });
        return fieldShell(spec, input);
      }

      case 'map':
      case 'maplist': {
        const isList = spec.type === 'maplist';
        const rows = h('div', { class: 'kv-rows' });
        const container = h('div', { class: 'kv' }, rows,
          h('button', { type: 'button', class: 'btn btn-small', text: '+ add', onclick: () => { addRow('', ''); } }));

        const commit = () => {
          const obj = {};
          for (const row of rows.children) {
            const key = row.querySelector('.kv-key').value.trim();
            const val = row.querySelector('.kv-val').value;
            if (!key) continue;
            obj[key] = isList ? val.split(',').map((s) => s.trim()).filter(Boolean) : val;
          }
          if (Object.keys(obj).length === 0) deleteIn(root, path);
          else setIn(root, path, obj);
          onChange();
        };

        const addRow = (key, val) => {
          const row = h('div', { class: 'kv-row' },
            h('input', { type: 'text', class: 'kv-key', spellcheck: 'false', placeholder: spec.keyPlaceholder || 'name', value: key }),
            h('input', { type: 'text', class: 'kv-val', spellcheck: 'false', placeholder: isList ? 'value1, value2' : (spec.valuePlaceholder || 'value'), value: val }),
            h('button', { type: 'button', class: 'btn btn-ghost btn-small', text: '✕', onclick: () => { row.remove(); commit(); } }));
          row.querySelectorAll('input').forEach((i) => i.addEventListener('input', commit));
          rows.append(row);
        };

        if (isObj(current)) {
          for (const [k, v] of Object.entries(current)) {
            addRow(k, isList ? (Array.isArray(v) ? v.join(', ') : String(v)) : String(v));
          }
        }
        return fieldShell(spec, container, { wide: true });
      }

      case 'object': {
        const fields = resolveFields(spec);
        const body = h('div', { class: 'field-grid' });
        for (const [k, sub] of Object.entries(fields)) {
          body.append(renderField(sub, root, [...path, k], onChange));
        }
        const details = h('details', { class: 'obj-group' },
          h('summary', {}, h('span', { text: spec.label || path[path.length - 1] })),
          body);
        if (isObj(getIn(root, path)) && Object.keys(getIn(root, path)).length > 0) details.open = true;
        const shell = h('div', { class: 'field field-wide' }, details);
        if (spec.help) details.append(h('div', { class: 'field-help', text: spec.help }));
        return shell;
      }

      case 'objectlist': {
        const itemFields = resolveFields(spec.item);
        const wrap = h('div', { class: 'objlist' });

        const rerender = () => {
          wrap.textContent = '';
          const arr = getIn(root, path);
          if (Array.isArray(arr)) {
            arr.forEach((item, i) => {
              const body = h('div', { class: 'field-grid' });
              for (const [k, sub] of Object.entries(itemFields)) {
                body.append(renderField(sub, item, [k], onChange));
              }
              const head = h('div', { class: 'objlist-head' },
                h('span', { class: 'muted mono', text: `#${i + 1}` }),
                h('span', { class: 'spacer' }),
                h('button', { type: 'button', class: 'btn btn-ghost btn-small', text: '↑', title: 'Move up', onclick: () => { if (i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; onChange(); rerender(); } } }),
                h('button', { type: 'button', class: 'btn btn-ghost btn-small', text: '↓', title: 'Move down', onclick: () => { if (i < arr.length - 1) { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; onChange(); rerender(); } } }),
                h('button', { type: 'button', class: 'btn btn-ghost btn-small', text: '✕', title: 'Remove', onclick: () => { arr.splice(i, 1); if (arr.length === 0) deleteIn(root, path); onChange(); rerender(); } }));
              wrap.append(h('div', { class: 'objlist-item' }, head, body));
            });
          }
          wrap.append(h('button', {
            type: 'button', class: 'btn btn-small', text: `+ add ${spec.item.ref ? (S.types[spec.item.ref]?.label || 'item').toLowerCase() : 'item'}`,
            onclick: () => {
              let arr2 = getIn(root, path);
              if (!Array.isArray(arr2)) { arr2 = []; setIn(root, path, arr2); }
              arr2.push({});
              onChange();
              rerender();
            },
          }));
        };

        rerender();
        return fieldShell(spec, wrap, { wide: true });
      }

      case 'raw': {
        const note = h('div', { class: 'muted', text: 'This option is only editable in YAML mode.' });
        return fieldShell(spec, note, { wide: true });
      }

      default:
        return h('div', {});
    }
  }

  /* ------------------------------------------------------------------ */

  function renderModuleForm(container, { doc, name, onChange, onProberChange }) {
    container.textContent = '';
    const module = doc.modules[name];
    if (!isObj(module)) {
      container.append(h('p', { class: 'muted', text: 'This module is not a YAML mapping — fix it in YAML mode.' }));
      return;
    }
    const prober = module.prober;
    const probe = S.probes[prober];

    const proberSel = h('select', {}, ...Object.keys(S.probes).map((p) =>
      h('option', { value: p, text: `${p} — ${S.probes[p].label}` })));
    if (probe) proberSel.value = prober;
    else proberSel.append(h('option', { value: prober || '', text: `${prober || '(none)'} (unknown)`, selected: 'selected' }));
    proberSel.addEventListener('change', () => {
      const next = proberSel.value;
      module.prober = next;
      if (!isObj(module[next])) {
        const tpl = clone(S.probes[next]?.template?.[next]);
        if (tpl && Object.keys(tpl).length > 0) module[next] = tpl;
      }
      onChange();
      onProberChange();
    });

    const head = h('div', { class: 'field-grid' },
      fieldShell({ label: 'Prober', help: 'The protocol over which the probe will take place.' }, proberSel),
      renderField(S.module.timeout, module, ['timeout'], onChange));
    container.append(head);

    if (!probe) {
      container.append(h('p', { class: 'error-text', text: `Unknown prober "${prober}" — supported: ${Object.keys(S.probes).join(', ')}.` }));
      return;
    }

    if (probe.description) {
      container.append(h('p', { class: 'muted prober-desc', text: probe.description }));
    }

    const main = h('div', { class: 'field-grid' });
    const advanced = h('div', { class: 'field-grid' });
    for (const [key, spec] of Object.entries(probe.fields)) {
      const target = spec.advanced ? advanced : main;
      target.append(renderField(spec, module, [prober, key], onChange));
    }
    container.append(h('h3', { class: 'section-title', text: `${probe.label} options` }), main);
    if (advanced.children.length > 0) {
      container.append(h('details', { class: 'advanced' },
        h('summary', { text: 'Advanced options' }),
        advanced));
    }
  }

  return {
    init: (schema) => { S = schema; },
    renderModuleForm,
    clone,
  };
})();
