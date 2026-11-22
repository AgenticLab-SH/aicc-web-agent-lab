const SURFACES = new Set(['business-full', 'personal-read-fetch']);
const COMMON_FLAGS = new Set(['--json', '--personal-read-fetch']);
const CONFIGURE_FLAGS = new Set([
  '--include-projects-root', '--include-owner-content-roots', '--owner-unrestricted-write', '--unrestricted-local-access',
  '--unrestricted-windows-commands'
]);

export function parseWorkspaceSubcommandOptions(subcommand, argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, surfaceProfile: null };
  const allowed = new Set([...COMMON_FLAGS, '--surface']);
  if (subcommand === 'configure') for (const flag of CONFIGURE_FLAGS) allowed.add(flag);
  if (subcommand === 'reconcile-roots') allowed.add('--dry-run');
  if (['doctor', 'serve'].includes(subcommand)) allowed.add('--local');
  if (subcommand === 'configure-local') {
    for (const flag of ['--dry-run', '--repair', '--alias', '--source-surface']) allowed.add(flag);
  }
  const seen = new Set();
  let explicitSurface = null;
  let sourceSurface = null;
  const aliases = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!allowed.has(token)) throw new Error(`unknown workspace ${subcommand} option: ${token}`);
    if (seen.has(token) && token !== '--alias') throw new Error(`duplicate workspace ${subcommand} option: ${token}`);
    seen.add(token);
    if (token === '--surface') {
      const value = argv[index + 1];
      if (!SURFACES.has(value)) throw new Error('--surface must be business-full or personal-read-fetch');
      explicitSurface = value;
      index += 1;
    } else if (token === '--source-surface') {
      sourceSurface = argv[++index];
      if (!SURFACES.has(sourceSurface)) throw new Error('--source-surface must be business-full or personal-read-fetch');
    } else if (token === '--alias') {
      const alias = argv[++index];
      if (!/^[a-z0-9._-]+$/.test(alias ?? '') || alias.startsWith('-') || aliases.includes(alias)) throw new Error('Invalid or duplicate --alias');
      aliases.push(alias);
    }
  }
  if (seen.has('--personal-read-fetch')) {
    if (explicitSurface && explicitSurface !== 'personal-read-fetch') throw new Error('conflicting Workspace surface options');
    explicitSurface = 'personal-read-fetch';
  }
  if (['configure', 'configure-local', 'prepare-client-config'].includes(subcommand) && !explicitSurface) {
    throw new Error(`workspace ${subcommand} requires --surface business-full|personal-read-fetch`);
  }
  return {
    help: false,
    surfaceProfile: explicitSurface ?? 'business-full',
    local: seen.has('--local'),
    sourceSurface,
    aliases,
    repair: seen.has('--repair'),
    json: seen.has('--json'),
    includeProjectsRoot: seen.has('--include-projects-root'),
    includeOwnerContentRoots: seen.has('--include-owner-content-roots'),
    ownerUnrestrictedWrite: seen.has('--owner-unrestricted-write'),
    unrestrictedLocalAccess: seen.has('--unrestricted-local-access'),
    unrestrictedWindowsCommands: seen.has('--unrestricted-windows-commands'),
    dryRun: seen.has('--dry-run')
  };
}
