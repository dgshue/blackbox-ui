'use strict';

const yaml = require('js-yaml');
const schema = require('../shared/schema.json');

const DURATION_RE = /^([0-9]+(ms|s|m|h|d|w|y))+$/;
const SIZE_RE = /^[0-9]+(B|KB|MB|GB|TB|PB|EB|KiB|MiB|GiB|TiB|PiB|EiB)?$/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function resolveFields(spec) {
  if (spec.ref) return schema.types[spec.ref]?.fields || {};
  return spec.fields || {};
}

/**
 * Structural validation against shared/schema.json.
 * Only YAML syntax and the basic modules/prober shape are errors —
 * everything else is a warning, because blackbox exporter itself is the
 * authoritative validator at reload time.
 */
function validateParsed(doc) {
  const errors = [];
  const warnings = [];
  const err = (path, msg) => errors.push({ path, msg });
  const warn = (path, msg) => warnings.push({ path, msg });

  if (!isPlainObject(doc)) {
    err('', 'configuration must be a YAML mapping with a top-level "modules" key');
    return { errors, warnings };
  }
  for (const key of Object.keys(doc)) {
    if (key !== 'modules') warn(key, 'unknown top-level key (blackbox exporter only uses "modules")');
  }
  if (!isPlainObject(doc.modules)) {
    err('modules', '"modules" must be a mapping of module name to module definition');
    return { errors, warnings };
  }
  if (Object.keys(doc.modules).length === 0) {
    warn('modules', 'no modules defined');
  }

  const proberNames = Object.keys(schema.probes);
  for (const [name, mod] of Object.entries(doc.modules)) {
    const base = `modules.${name}`;
    if (!isPlainObject(mod)) {
      err(base, 'module must be a mapping');
      continue;
    }
    const prober = mod.prober;
    if (typeof prober !== 'string' || !prober) {
      err(`${base}.prober`, `"prober" is required (one of: ${proberNames.join(', ')})`);
      continue;
    }
    if (!proberNames.includes(prober)) {
      err(`${base}.prober`, `unknown prober "${prober}" (expected one of: ${proberNames.join(', ')})`);
      continue;
    }
    if (mod.timeout !== undefined) {
      checkField(`${base}.timeout`, schema.module.timeout, mod.timeout, warn);
    }
    for (const key of Object.keys(mod)) {
      if (key === 'prober' || key === 'timeout') continue;
      if (proberNames.includes(key)) {
        if (key !== prober) warn(`${base}.${key}`, `section "${key}" is ignored because prober is "${prober}"`);
        continue;
      }
      warn(`${base}.${key}`, 'unknown module option');
    }
    const section = mod[prober];
    if (section !== undefined) {
      if (!isPlainObject(section)) {
        warn(`${base}.${prober}`, 'prober configuration must be a mapping');
      } else {
        checkObject(`${base}.${prober}`, schema.probes[prober].fields, section, warn);
      }
    }
    for (const [fieldName, spec] of Object.entries(schema.probes[prober].fields)) {
      if (spec.required && (section === undefined || section?.[fieldName] === undefined)) {
        warn(`${base}.${prober}.${fieldName}`, `"${fieldName}" is required for the ${prober} prober`);
      }
    }
  }
  return { errors, warnings };
}

function checkObject(path, fields, value, warn) {
  for (const [key, v] of Object.entries(value)) {
    const spec = fields[key];
    if (!spec) {
      warn(`${path}.${key}`, 'unknown option');
      continue;
    }
    checkField(`${path}.${key}`, spec, v, warn);
  }
}

function checkField(path, spec, value, warn) {
  if (value === undefined || value === null) return;
  switch (spec.type) {
    case 'string':
    case 'secret':
      if (typeof value !== 'string') warn(path, 'expected a string');
      break;
    case 'size':
      if (typeof value !== 'string' && typeof value !== 'number') warn(path, 'expected a size (e.g. 10MB)');
      else if (typeof value === 'string' && !SIZE_RE.test(value)) warn(path, `"${value}" does not look like a size (e.g. 10MB)`);
      break;
    case 'duration':
      if (typeof value === 'number') warn(path, 'durations need a unit, e.g. "5s"');
      else if (typeof value !== 'string' || !DURATION_RE.test(value)) warn(path, `"${value}" is not a valid duration (e.g. 5s, 1m30s)`);
      break;
    case 'int':
      if (!Number.isInteger(value)) warn(path, 'expected an integer');
      break;
    case 'bool':
      if (typeof value !== 'boolean') warn(path, 'expected true or false');
      break;
    case 'enum':
      if (typeof value !== 'string') warn(path, 'expected a string');
      else if (!spec.allowCustom && !spec.enum.includes(value)) {
        warn(path, `"${value}" is not one of: ${spec.enum.join(', ')}`);
      }
      break;
    case 'stringlist':
      if (!Array.isArray(value)) warn(path, 'expected a list of strings');
      else value.forEach((v, i) => typeof v !== 'string' && warn(`${path}[${i}]`, 'expected a string'));
      break;
    case 'intlist':
      if (!Array.isArray(value)) warn(path, 'expected a list of integers');
      else value.forEach((v, i) => !Number.isInteger(v) && warn(`${path}[${i}]`, 'expected an integer'));
      break;
    case 'map':
      if (!isPlainObject(value)) warn(path, 'expected a mapping');
      else {
        for (const [k, v] of Object.entries(value)) {
          if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
            warn(`${path}.${k}`, 'expected a scalar value');
          }
        }
      }
      break;
    case 'maplist':
      if (!isPlainObject(value)) warn(path, 'expected a mapping of name to list of values');
      else {
        for (const [k, v] of Object.entries(value)) {
          if (!Array.isArray(v)) warn(`${path}.${k}`, 'expected a list of values');
        }
      }
      break;
    case 'object':
      if (!isPlainObject(value)) warn(path, 'expected a mapping');
      else checkObject(path, resolveFields(spec), value, warn);
      break;
    case 'objectlist':
      if (!Array.isArray(value)) warn(path, 'expected a list');
      else {
        value.forEach((item, i) => {
          if (!isPlainObject(item)) warn(`${path}[${i}]`, 'expected a mapping');
          else checkObject(`${path}[${i}]`, resolveFields(spec.item), item, warn);
        });
      }
      break;
    case 'raw':
      break;
    default:
      break;
  }
}

function parseYaml(raw) {
  try {
    return { doc: yaml.load(raw) ?? null };
  } catch (e) {
    return {
      error: {
        msg: e.reason || e.message,
        line: e.mark ? e.mark.line + 1 : null,
        column: e.mark ? e.mark.column + 1 : null,
      },
    };
  }
}

function validateRaw(raw) {
  const { doc, error } = parseYaml(raw);
  if (error) {
    return { ok: false, syntax: error, errors: [{ path: '', msg: `YAML syntax error: ${error.msg}` }], warnings: [] };
  }
  const { errors, warnings } = validateParsed(doc);
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateRaw, validateParsed, parseYaml };
