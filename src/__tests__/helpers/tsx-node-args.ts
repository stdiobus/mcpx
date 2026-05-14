export function tsxEsmNodeArgs(): string[] {
  const major = Number(process.versions.node.split('.')[0] || 0);
  // Node 20+ supports `--import` for ESM loaders.
  // Node 18 uses `--experimental-loader` (the `--loader` alias appears later).
  return major >= 20 ? ['--import', 'tsx/esm'] : ['--experimental-loader', 'tsx/esm'];
}
