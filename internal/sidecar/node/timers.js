// node:timers for programs in moejs: the timer functions of the run, which
// are also its globals.
import * as promises from 'node:timers/promises';

const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate } = import.meta.timers;

export { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, promises };
export default { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, promises };
