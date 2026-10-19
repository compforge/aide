/** Logical routing IDs are not filesystem paths; directory encoding belongs to SessionStore. */
export function assertSessionId(id: string): void {
  if (!id.trim() || id.length > 200 || /[\\/\0]/.test(id) || id === "." || id === "..") {
    throw new Error("aideSessionId must be a non-empty stable identifier without path separators (max 200 characters)");
  }
}
