export function tsxEsmNodeArgs(): string[] {
  const major = Number(process.versions.node.split('.')[0] || 0);
  return major >= 20 ? ['--import', 'tsx/esm'] : ['--loader', 'tsx/esm'];
}

