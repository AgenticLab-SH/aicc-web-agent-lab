import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readWorkspaceMcpConfig, workspaceMcpPaths, workspaceMcpCommand, workspaceMcpRoot } from './workspace-mcp.mjs';

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const NODE_FIELDS = new Set(['command', 'args', 'env', 'env_vars', 'startup_timeout_sec', 'tool_timeout_sec', 'enabled']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}
function text(value, name) {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) throw new Error(`${name} must be a string without controls`);
  return value;
}
function absolute(value, name, directory = false) {
  text(value, name);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  const resolved = path.resolve(value);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`${name} has an unsafe type`);
  const canonical = fs.realpathSync(resolved);
  const key = item => process.platform === 'win32' ? item.toLowerCase() : item;
  if (key(canonical) !== key(resolved)) throw new Error(`${name} must not traverse an alias`);
  return canonical;
}
function strings(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => text(item, `${name}[${index}]`));
}
function pluginBinding(input) {
  if (input == null) return { state: 'UNBOUND', activationAllowed: false };
  record(input, 'marketplace');
  const root = absolute(input.root, 'marketplace.root', true);
  const relative = text(input.pluginRelativePath, 'marketplace.pluginRelativePath');
  const parts = relative.split(/[\\/]/);
  if (path.isAbsolute(relative) || parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error('pluginRelativePath must remain below the explicit marketplace root');
  }
  const directory = path.join(root, ...parts);
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  absolute(ancestor, 'marketplace existing parent', true);
  return { state: 'PREPARED_ONLY', root, pluginDirectory: directory, mcpFile: path.join(directory, '.mcp.json'), activationAllowed: false };
}
function nodeReplCandidate(input) {
  if (input == null) return { state: 'PRESERVE_EXISTING_PROVIDER_CONFIGURATION', fragmentToml: null, activationAllowed: false };
  record(input, 'nodeRepl');
  const sourceOwner = text(input.sourceOwner, 'nodeRepl.sourceOwner');
  if (!sourceOwner.trim()) throw new Error('nodeRepl source owner is required');
  const config = record(input.config, 'nodeRepl.config');
  for (const key of Object.keys(config)) if (!NODE_FIELDS.has(key)) throw new Error(`Unsupported node_repl field ${key}; preserve its original producer`);
  const command = absolute(config.command, 'nodeRepl.command');
  const args = own(config, 'args') ? strings(config.args, 'nodeRepl.args') : [];
  const lines = ['[mcp_servers.node_repl]', `command = ${JSON.stringify(command)}`, `args = ${JSON.stringify(args)}`];
  if (own(config, 'env_vars')) {
    const names = strings(config.env_vars, 'nodeRepl.env_vars');
    if (names.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('Invalid inherited environment name');
    lines.push(`env_vars = ${JSON.stringify(names)}`);
  }
  for (const name of ['startup_timeout_sec', 'tool_timeout_sec']) {
    if (!own(config, name)) continue;
    if (!Number.isFinite(config[name]) || config[name] <= 0) throw new Error(`Invalid ${name}`);
    lines.push(`${name} = ${config[name]}`);
  }
  if (own(config, 'enabled')) {
    if (typeof config.enabled !== 'boolean') throw new Error('nodeRepl.enabled must be boolean');
    lines.push(`enabled = ${config.enabled}`);
  }
  if (own(config, 'env')) {
    record(config.env, 'nodeRepl.env');
    lines.push('', '[mcp_servers.node_repl.env]');
    for (const [key, value] of Object.entries(config.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid nodeRepl environment key');
      lines.push(`${JSON.stringify(key)} = ${JSON.stringify(text(value, `nodeRepl.env.${key}`))}`);
    }
  }
  return {
    state: 'PREPARED_ONLY', sourceOwner, fragmentToml: `${lines.join('\n')}\n`, activationAllowed: false,
    rebindingRequired: 'Provider installer owns runtime version, browser service and current native pipe. Do not transplant another host or session values.'
  };
}

// Preparation only: no writes, processes, plugin registration, config migration or service starts.
export function prepareWorkspaceClientConfig(input = {}, options = {}) {
  record(input, 'client bindings');
  if (input.schemaVersion !== 1) throw new Error('client bindings schemaVersion must be 1');
  if (!['personal-read-fetch', 'business-full'].includes(options.surfaceProfile)) throw new Error('Explicit existing surface is required');
  if (!ID.test(input.serverName ?? '') || input.serverName === 'node_repl') throw new Error('An explicit distinct Workspace serverName is required');
  const resolverOptions = { surfaceProfile: options.surfaceProfile, local: true };
  if (input.stateRoot != null) resolverOptions.stateRoot = absolute(input.stateRoot, 'stateRoot', true);
  const paths = workspaceMcpPaths(resolverOptions);
  const configPath = absolute(paths.config, 'existing local Workspace config');
  const config = readWorkspaceMcpConfig(resolverOptions);
  if (!config || config.managedBy !== 'aicc-workspace-local-stdio-v1' || config.transport?.mode !== 'local-stdio'
      || config.remoteAuthority?.authenticationOwner !== 'codex-local-stdio') {
    throw new Error('Existing configure-local owned STDIO configuration required; remote credentials are not reused');
  }
  const sourceRoot = absolute(input.sourceRoot ?? workspaceMcpRoot, 'sourceRoot', true);
  const serverPath = absolute(path.join(sourceRoot, 'components', 'workspace-mcp', 'server.mjs'), 'Workspace server');
  const nodeExecutable = absolute(input.nodeExecutable ?? process.execPath, 'nodeExecutable');
  const command = workspaceMcpCommand(config, { ...resolverOptions, configPath, serverPath, nodeExecutable });
  return {
    schemaVersion: 1, state: 'PREPARED_ONLY', localOnly: true,
    provenance: {
      producer: 'aicc workspace prepare-client-config', sourceRoot, configPath,
      configSha256: createHash('sha256').update(fs.readFileSync(configPath)).digest('hex'),
      surfaceProfile: config.surfaceProfile, permissionChanges: false,
      portableMeaning: 'Regenerate with destination-owner bindings; no account, runtime version or fixed executable is embedded in public source.'
    },
    marketplace: pluginBinding(input.marketplace),
    workspaceMcpJson: { mcpServers: { [input.serverName]: { command: command.executable, args: command.args, cwd: sourceRoot } } },
    nodeRepl: nodeReplCandidate(input.nodeRepl),
    activation: {
      applied: false, installerOwner: null,
      required: ['Confirm current exact marketplace/plugin identity and supported installer owner', 'Installer preserves existing config, originals and rollback', 'Rebind provider runtime/session paths through their owner; never edit supplier cache'],
      automaticRegistration: false
    }
  };
}
