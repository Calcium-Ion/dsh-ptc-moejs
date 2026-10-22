/**
 * Finds the sidecar binary. Each supported platform has its own package,
 * installed as an optional dependency, as esbuild ships its binary.
 * @module dsh-ptc-moejs/binary
 */

import { createRequire } from 'node:module'

/** The platforms that have a binary package. */
export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'] as const

/**
 * Name the package that holds the sidecar binary for a platform.
 * npm's spam filter rejects the name dsh-ptc-moejs-win32-x64, so the
 * Windows package says "windows" where Node says "win32".
 * @param platform - the Node platform name.
 * @param arch - the Node architecture name.
 * @returns the npm package name.
 */
export function binaryPackage(platform: string, arch: string): string {
  return `dsh-ptc-moejs-${platform === 'win32' ? 'windows' : platform}-${arch}`
}

/**
 * Resolve the sidecar binary for this platform.
 * @param platform - the Node platform name.
 * @param arch - the Node architecture name.
 * @returns the absolute path of the binary.
 * @throws When no binary package for the platform is installed.
 */
export function resolveBinary(platform: string = process.platform, arch: string = process.arch): string {
  const target = `${platform}-${arch}`
  const pkg = binaryPackage(platform, arch)
  try {
    return createRequire(import.meta.url).resolve(`${pkg}/bin/moejs-ptc${platform === 'win32' ? '.exe' : ''}`)
  } catch {
    const supported = (PLATFORMS as readonly string[]).includes(target)
    throw new Error(supported
      ? `dsh-ptc-moejs: the sidecar package ${pkg} is not installed; reinstall with optional dependencies enabled`
      : `dsh-ptc-moejs: no sidecar binary for ${target} (supported: ${PLATFORMS.join(', ')})`)
  }
}
