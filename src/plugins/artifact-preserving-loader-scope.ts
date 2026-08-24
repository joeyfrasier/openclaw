import { AsyncLocalStorage } from "node:async_hooks";

const artifactPreservingPluginLoaderScope = new AsyncLocalStorage<boolean>();

/** Run plugin inspection without writing transformed-module caches into the operator home. */
export async function withArtifactPreservingPluginLoaderReads<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return await artifactPreservingPluginLoaderScope.run(true, operation);
}

/** Returns whether the current inspection must keep plugin loading filesystem-artifact free. */
export function isArtifactPreservingPluginLoaderReadActive(): boolean {
  return artifactPreservingPluginLoaderScope.getStore() === true;
}
