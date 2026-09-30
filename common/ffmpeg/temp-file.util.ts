import fs from "fs";
import os from "os";
import path from "path";

export function writeTempFile(buffer: Buffer, extension: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "madar-media-"));
  const filePath = path.join(dir, `input.${extension.replace(/^\./, "")}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export function removeTempPath(filePath: string): void {
  const dir = path.dirname(filePath);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
