import { join } from 'node:path';

/**
 * Joins path segments, handling both local filesystem paths and remote storage URLs.
 *
 * For remote URLs (starting with https:// or http://):
 * - Uses URL API to properly join path segments while preserving URL structure
 * - path.join() is not suitable for URLs as it may incorrectly normalize '://' to ':/'
 *
 * For local filesystem paths:
 * - Uses standard path.join() which works correctly in Docker/Linux environment
 *
 * @param segments - Path segments to join
 * @returns Joined path or URL
 *
 * @example
 * // Local filesystem path
 * joinPath('/usr/src/app', 'upload', 'file.jpg')
 * // => '/usr/src/app/upload/file.jpg'
 *
 * @example
 * // Remote storage URL
 * joinPath('https://example.com/bucket', 'folder', 'file.jpg')
 * // => 'https://example.com/bucket/folder/file.jpg'
 */
export function joinPath(...segments: string[]): string {
  if (segments.length === 0) {
    return '';
  }

  const firstSegment = segments.shift()!;

  // Check if this is a remote storage URL
  if (firstSegment.startsWith('https://')) {
    const url = new URL(firstSegment);
    // Join URL pathname with remaining segments directly
    url.pathname = join(url.pathname, ...segments);
    return url.href;
  }

  // Local filesystem path: use standard path.join()
  return join(firstSegment, ...segments);
}
