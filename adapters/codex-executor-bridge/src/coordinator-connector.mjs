import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexCoordinator } from './coordinator.mjs';

export const apiVersion = 1;

/** The only coordinator module coupled to the host extension contract. */
export function createCoordinator(host) {
  let config = {};
  try { config = JSON.parse(readFileSync(join(host.stateDir, 'codex-coordinator.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(k => !['command', 'model', 'timeoutMs', 'turnTimeoutMs'].includes(k))) {
    throw new Error('Unsupported coordinator configuration');
  }
  for (const name of ['timeoutMs', 'turnTimeoutMs']) {
    if (config[name] !== undefined && (!Number.isSafeInteger(config[name]) || config[name] <= 0)) throw new Error(`${name} must be a positive integer`);
  }
  return new CodexCoordinator({ ...config, host });
}
