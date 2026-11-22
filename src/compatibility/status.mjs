import path from 'node:path';
import os from 'node:os';
import { buildCompatibilityMatrix, loadReleaseMatrix } from './lab.mjs';
import { UpdateCoordinator } from './update-coordinator.mjs';

export function compatibilityStatus(options = {}) {
  try {
    const release = loadReleaseMatrix(options);
    const matrix = buildCompatibilityMatrix(release, { observedAt: options.observedAt, evidenceRef: options.evidenceRef ?? null });
    const coordinator = options.coordinator ?? new UpdateCoordinator({ stateRoot: options.stateRoot ?? path.join(process.env.AICC_STATE_ROOT || path.join(os.homedir(), '.ai-control-center'), 'compatibility') });
    const state = coordinator.status();
    const incompatible = matrix.components.filter(item => item.compatibility !== 'compatible');
    const quarantined = state.quarantinedComponents.length;
    const ready = incompatible.length === 0 && quarantined === 0;
    return {
      id: 'compatibility-lab',
      label: '호환성·업데이트 Canary',
      state: ready ? 'ready' : 'attention',
      detail: ready
        ? `${matrix.components.length}개 component 호환 · live update 0개 · quarantine 0개`
        : `호환 차단 ${incompatible.length}개 · quarantine ${quarantined}개`,
      releaseId: matrix.releaseId,
      componentCount: matrix.components.length,
      incompatible: incompatible.map(item => item.id),
      activePlans: state.activePlans,
      holdPlans: state.holdPlans,
      quarantinedComponents: state.quarantinedComponents,
      automaticVersionApply: release.policy.automaticVersionApply,
      rolloutSequence: release.policy.sequence,
      restartBudget: release.policy.restartBudget
    };
  } catch (error) {
    return {
      id: 'compatibility-lab',
      label: '호환성·업데이트 Canary',
      state: 'attention',
      detail: '호환성 release matrix 또는 coordinator 상태 검증에 실패했습니다.',
      isolatedFailure: true,
      error: error.code ?? 'compatibility_validation_failed'
    };
  }
}
