import { ExtensionRegistry } from './registry.mjs';

export function extensionRegistryStatus(options = {}) {
  try {
    const validated = (options.registry ?? new ExtensionRegistry(options)).validate();
    return {
      id: 'extensions',
      label: 'Plugin·Skill 패키지',
      state: 'ready',
      detail: `공개 extension ${validated.extensionCount}개 · integrity/secret scan 통과`,
      schemaVersion: validated.schemaVersion,
      extensionCount: validated.extensionCount,
      marketplace: validated.marketplace,
      extensions: validated.extensions.map(item => ({
        id: item.id,
        version: item.version,
        fileCount: item.fileCount,
        digest: item.digest,
        secretScan: item.secretScan,
        mcpToolCount: item.plugin ? Object.keys(item.plugin.mcp.mcpServers ?? {}).length === 1 ? 8 : 0 : 0
      }))
    };
  } catch (error) {
    return {
      id: 'extensions',
      label: 'Plugin·Skill 패키지',
      state: 'attention',
      detail: '공개 extension registry 또는 package 검증에 실패했습니다.',
      isolatedFailure: true,
      error: error.code ?? 'extension_validation_failed'
    };
  }
}
