// node:path/win32 for programs in moejs.
import { win32 } from 'node:path';

export default win32;
export const {
  resolve, normalize, isAbsolute, join, relative, toNamespacedPath, dirname, basename, extname,
  format, parse, matchesGlob, sep, delimiter, posix,
} = win32;
export { win32 };
