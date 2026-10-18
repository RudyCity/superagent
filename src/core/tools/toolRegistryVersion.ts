let version = 0;

/** Version of the shared tool catalog, bumped whenever dynamic hooks refresh. */
export function getToolRegistryVersion(): number {
  return version;
}

export function bumpToolRegistryVersion(): void {
  version += 1;
}
