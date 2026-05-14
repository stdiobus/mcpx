export function tsxEsmNodeArgs(): string[] {
  const [majS, minS] = process.versions.node.split('.');
  const major = Number(majS || 0);
  const minor = Number(minS || 0);

  // `tsx` enforces `--import` on Node v18.19.0+ (and Node 20+).
  // Older Node 18 minors don't have `--import` and must use `--loader`.
  const supportsImportFlag =
    major >= 20 || major === 19 || (major === 18 && minor >= 19);

  return supportsImportFlag ? ['--import', 'tsx/esm'] : ['--loader', 'tsx/esm'];
}
