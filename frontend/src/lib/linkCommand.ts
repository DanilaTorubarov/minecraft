/** The same complete command is displayed and copied, including the issued code. */
export function linkCommand(code: string): string {
  return `/website link ${code}`
}
