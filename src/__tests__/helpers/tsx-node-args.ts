export function tsxEsmNodeArgs(): string[] {
  const major = Number(process.versions.node.split('.')[0] || 0);
  // Node 20+ supports `--import` for ESM loaders.
  // Node 18/19 should use `--loader` (the older `--experimental-loader` is not reliable across minors).
  return major >= 20 ? ['--import', 'tsx/esm'] : ['--loader', 'tsx/esm'];
}
