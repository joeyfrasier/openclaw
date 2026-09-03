import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function importSecretRefRuntime() {
  const candidates = [
    new URL("../../dist/plugin-sdk/secret-ref-runtime.js", import.meta.url),
    new URL("../../plugin-sdk/secret-ref-runtime.js", import.meta.url),
    new URL("../../../dist/plugin-sdk/secret-ref-runtime.js", import.meta.url),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(fileURLToPath(candidate))) {
      return import(candidate.href);
    }
  }
  throw new Error("OpenClaw SecretRef runtime is unavailable");
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

export async function resolveTrustedOnePasswordCli(options = {}) {
  // Keep this SDK import lazy. The helper is also bundled into the normal
  // 1Password plugin graph, where top-level await would invalidate index.js.
  const { pluginSecretRefSetup } = await importSecretRefRuntime();
  const resolveTrustedExecutablePath = pluginSecretRefSetup.resolveTrustedExecutablePath;
  const configuredPath = options.configuredPath?.trim();
  if (configuredPath && !path.isAbsolute(configuredPath)) {
    throw new Error(`1Password CLI path must be absolute: ${configuredPath}`);
  }
  const executable = process.platform === "win32" ? "op.exe" : "op";
  const candidates = configuredPath
    ? [configuredPath]
    : (options.pathEnv ?? process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.resolve(directory, executable));
  let unsafeError;
  for (const candidate of candidates) {
    try {
      return await resolveTrustedExecutablePath(candidate);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        continue;
      }
      unsafeError = new Error(
        `Refusing unsafe 1Password CLI path "${candidate}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      if (configuredPath) {
        throw unsafeError;
      }
    }
  }
  if (unsafeError) {
    throw unsafeError;
  }
  return undefined;
}
