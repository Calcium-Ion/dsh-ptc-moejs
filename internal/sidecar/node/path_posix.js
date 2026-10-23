// node:path/posix for programs in moejs.
import { posix } from 'node:path';

export default posix;
export const {
  resolve, normalize, isAbsolute, join, relative, toNamespacedPath, dirname, basename, extname,
  format, parse, matchesGlob, sep, delimiter, win32,
} = posix;
export { posix };
