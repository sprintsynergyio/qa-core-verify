/**
 * A small checker for the subset of JSON Schema draft 2020-12 used by schema/report.schema.json.
 * It is not a general validator.
 */
export function validateSchema(schema, data) {
  const errors = [];
  checkNode(schema, data, '$', schema, errors);
  return errors;
}

function checkNode(schema, data, path, root, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (typeof schema.$ref === 'string') {
    checkNode(resolveRef(root, schema.$ref), data, path, root, errors);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !same(data, schema.const)) {
    errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => same(entry, data))) {
    errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
    return;
  }
  if (schema.type !== undefined && !typeMatches(schema.type, data)) {
    errors.push(`${path} has the wrong type`);
    return;
  }
  if (typeof data === 'string') {
    if (typeof schema.minLength === 'number' && data.length < schema.minLength) errors.push(`${path} is too short`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(data)) errors.push(`${path} does not match ${schema.pattern}`);
  }
  if (typeof data === 'number') {
    if (typeof schema.minimum === 'number' && data < schema.minimum) errors.push(`${path} is below ${schema.minimum}`);
  }
  if (Array.isArray(data)) {
    if (typeof schema.minItems === 'number' && data.length < schema.minItems) errors.push(`${path} has too few items`);
    if (schema.items) {
      for (let index = 0; index < data.length; index += 1) {
        checkNode(schema.items, data[index], `${path}[${index}]`, root, errors);
      }
    }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) errors.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(data, key)) checkNode(child, data[key], `${path}.${key}`, root, errors);
    }
  }
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported ref ${ref}`);
  let current = root;
  for (const part of ref.slice(2).split('/')) {
    current = current?.[part];
  }
  if (!current) throw new Error(`Missing ref ${ref}`);
  return current;
}

function typeMatches(type, data) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => oneType(entry, data));
}

function oneType(type, data) {
  if (type === 'null') return data === null;
  if (type === 'string') return typeof data === 'string';
  if (type === 'boolean') return typeof data === 'boolean';
  if (type === 'integer') return Number.isInteger(data);
  if (type === 'number') return typeof data === 'number';
  if (type === 'array') return Array.isArray(data);
  if (type === 'object') return data !== null && typeof data === 'object' && !Array.isArray(data);
  return false;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
