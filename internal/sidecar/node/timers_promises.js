// node:timers/promises for programs in moejs. moejs has no AbortSignal, so
// the signal option is refused; the ref option works as in Node.
const timers = import.meta.timers;

function validateOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object') {
    const error = new TypeError(`The "options" argument must be of type object. Received ${options === null ? 'null' : `type ${typeof options}`}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (options.signal !== undefined) throw new TypeError('The "signal" option is not available in this runtime, which has no AbortSignal');
  if (options.ref !== undefined && typeof options.ref !== 'boolean') {
    const error = new TypeError('The "options.ref" property must be of type boolean.');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  return options;
}

export function setTimeout(delay, value, options) {
  try {
    const { ref } = validateOptions(options);
    return new Promise((resolve) => {
      const timer = timers.setTimeout(resolve, delay, value);
      if (ref === false) timer.unref();
    });
  } catch (error) {
    return Promise.reject(error);
  }
}

export function setImmediate(value, options) {
  try {
    const { ref } = validateOptions(options);
    return new Promise((resolve) => {
      const immediate = timers.setImmediate(resolve, value);
      if (ref === false) immediate.unref();
    });
  } catch (error) {
    return Promise.reject(error);
  }
}

export async function* setInterval(delay, value, options) {
  const { ref } = validateOptions(options);
  let due = 0;
  let wake;
  const interval = timers.setInterval(() => {
    due++;
    if (wake !== undefined) {
      wake();
      wake = undefined;
    }
  }, delay);
  if (ref === false) interval.unref();
  try {
    for (;;) {
      if (due === 0) await new Promise((resolve) => { wake = resolve; });
      for (; due > 0; due--) yield value;
    }
  } finally {
    timers.clearInterval(interval);
  }
}

export const scheduler = {
  wait: (delay, options) => setTimeout(delay, undefined, options),
  yield: () => setImmediate(),
};

export default { setTimeout, setImmediate, setInterval, scheduler };
