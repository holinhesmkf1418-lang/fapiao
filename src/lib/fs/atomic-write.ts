import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function writeFileAtomically(
  filePath: string,
  contents: string,
): Promise<void> {
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    await writeFile(tmpPath, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}
