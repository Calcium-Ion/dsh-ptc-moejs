// node:vm for programs in moejs. A script runs in the program's own realm,
// with the properties of its context object as global names, since a moejs
// runtime has one realm. Node's vm is no security boundary either; the
// sidecar's process and the run's deadline are. The timeout option is not
// enforced: the run's deadline stops a script that does not end.

const contexts = new WeakSet();

function invalidArgType(name, expected, value) {
  const error = new TypeError(`The "${name}" argument must be ${expected}. Received ${value === null ? 'null' : typeof value}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

// Evaluates code with the context's properties in scope. The eval is
// direct, so the script sees the with statement's object; the parameter
// names are unlikely to be a context's.
const evaluate = new Function('$moejsVmContext', '$moejsVmCode', 'with ($moejsVmContext) { return eval($moejsVmCode); }');

export function createContext(contextObject = {}, options) {
  if (contextObject === null || typeof contextObject !== 'object') throw invalidArgType('contextObject', 'of type object', contextObject);
  if (options !== undefined && (options === null || typeof options !== 'object')) throw invalidArgType('options', 'of type object', options);
  contexts.add(contextObject);
  return contextObject;
}

export function isContext(object) {
  if (object === null || typeof object !== 'object') throw invalidArgType('object', 'of type object', object);
  return contexts.has(object);
}

function checkContext(context) {
  if (context === null || typeof context !== 'object' || !contexts.has(context)) {
    throw invalidArgType('contextifiedObject', 'an vm.Context', context);
  }
}

export class Script {
  #code;

  constructor(code, options) {
    if (options !== undefined && options !== null && typeof options !== 'object' && typeof options !== 'string') {
      throw invalidArgType('options', 'of type object', options);
    }
    this.#code = `${code}`;
    // Compiled now, so that a syntax error throws here, as in Node.
    new Function(this.#code);
  }

  runInContext(contextifiedObject, options) {
    checkContext(contextifiedObject);
    return Reflect.apply(evaluate, contextifiedObject, [contextifiedObject, this.#code]);
  }

  runInNewContext(contextObject, options) {
    return this.runInContext(createContext(contextObject), options);
  }

  runInThisContext(options) {
    return (0, eval)(this.#code);
  }

  createCachedData() {
    return new Uint8Array(0);
  }
}

export function runInContext(code, contextifiedObject, options) {
  return new Script(code, options).runInContext(contextifiedObject, options);
}

export function runInNewContext(code, contextObject, options) {
  return new Script(code, options).runInNewContext(contextObject, options);
}

export function runInThisContext(code, options) {
  return new Script(code, options).runInThisContext(options);
}

export function compileFunction(code, params = [], options = {}) {
  return new Function(...params, `${code}`);
}

export const constants = {
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('vm_dynamic_import_main_context_default'),
  DONT_CONTEXTIFY: Symbol('vm_context_no_contextify'),
};

export default { Script, compileFunction, constants, createContext, isContext, runInContext, runInNewContext, runInThisContext };
