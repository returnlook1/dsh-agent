/**
 * Atomic file writes: temporary file in the destination directory, then rename.
 *
 * On Windows `rename()` fails when the destination exists, so the destination is
 * removed immediately before the rename (the window is a few microseconds and
 * every reader of these files tolerates absence — they poll).
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Replace `path` with `data` atomically.
 * @param path destination path; parent directories are created as needed.
 * @param data full UTF-8 contents.
 */
export function writeFileAtomic(path: string, data: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  writeFileSync(temporary, data, 'utf8')
  try {
    if (process.platform === 'win32') {
      rmSync(path, { force: true })
    }
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
