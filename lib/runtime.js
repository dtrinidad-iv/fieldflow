// Everything a deployed handler needs, built once per Lambda container:
// config (environment), schema (table ids and slugs), secrets (SSM, refreshed after the TTL),
// the Tadabase adapter and a logger. Handlers call getRuntime() in their exported `handler`;
// tests build their own with createRuntime() and injected parts, or skip it entirely and pass
// the memory adapter to createHandler.
import { readConfig } from './config.js';
import { createLogger } from './log.js';
import { createTadabasePlatform } from './platform/tadabase.js';
import { loadSchema } from './schema.js';
import { createSecretLoader, ssmGetParameters } from './secrets.js';

export function createRuntime({
  env = process.env,
  schema,
  // Only the secrets the function's IAM role allows: SSM denies the whole GetParameters call if
  // it names one the role can't read. Default: all of them (generate-invoice).
  secretKeys,
  getParameters = ssmGetParameters,
  fetch = globalThis.fetch,
  now = Date.now,
} = {}) {
  const config = readConfig(env);
  const mapping = schema ?? loadSchema(config.stage);
  if (mapping.placeholder) {
    throw new Error(
      `config/tadabase.${config.stage}.json still holds placeholder ids: run scripts/tadabase-check.js ${config.stage} and fill it in`,
    );
  }
  const secrets = createSecretLoader({ stage: config.stage, keys: secretKeys, getParameters, now });
  const log = createLogger({ stage: config.stage });

  return {
    config,
    schema: mapping,
    log,
    secrets: () => secrets.load(),
    // A fresh adapter per call is cheap, and always uses the current (possibly rotated) secrets.
    async platform() {
      const { tadabase } = await secrets.load();
      return createTadabasePlatform({
        ...tadabase,
        baseUrl: config.tadabase.baseUrl,
        timeoutMs: config.tadabase.timeoutMs,
        allowLiveWrites: config.allowLiveWrites,
        fetch,
      });
    },
  };
}

let shared;
let sharedKeys;
// One runtime per container. A failed build isn't kept, so the next invocation retries.
// Every call in a container must ask for the same secrets: the first call's choice sticks, and a
// later call that silently got different ones would be a bug.
export function getRuntime(options) {
  const keys = JSON.stringify(options?.secretKeys ?? null);
  if (shared && keys !== sharedKeys) throw new Error('getRuntime called with different secretKeys in one container');
  if (!shared) {
    shared = createRuntime(options);
    sharedKeys = keys;
  }
  return shared;
}

export function resetRuntimeForTests() {
  shared = undefined;
  sharedKeys = undefined;
}
