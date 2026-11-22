import { planAgenticIntervention } from './agentic-intervention.mjs';
import { armNotification } from './notification-command.mjs';
import { FocusGuard } from './control-plane/focus-guard.mjs';
import { createDefaultResourceLeaseManager } from './control-plane/resource-lease.mjs';

function guard(options = {}) {
  return options.focusGuard ?? new FocusGuard({
    resourceLeases: createDefaultResourceLeaseManager(options.resourceLeaseOptions ?? {})
  });
}

function focusSessionInput(request) {
  const session = request?.focusSession;
  if (!session || typeof session !== 'object') throw new Error('focus_session_required');
  return session;
}

function computerUsePreparation(request, plan, options) {
  if (plan.action !== 'use_computer') {
    return { ok: true, action: 'computer_use_not_selected', plan, focusSession: null };
  }
  const computerUse = request?.computerUse ?? {};
  if (typeof computerUse.userActive !== 'boolean') throw new Error('computer_use_activity_state_required');
  const exactTargetId = String(computerUse.exactTargetId ?? '').trim();
  if (!exactTargetId) throw new Error('computer_use_exact_target_required');
  const focusSession = guard(options).begin({
    ownerTaskId: request.taskId,
    ownerActorId: request.source ?? 'codex-agent',
    exactTargetId,
    userActive: computerUse.userActive,
    mutation: computerUse.mutation !== false,
    routeOptions: { foregroundComputerUseAvailable: true },
    recoveryRef: `intervention:${request.correlationId ?? request.eventId}`
  });
  return { ok: true, action: 'computer_use_prepared', plan, focusSession };
}

export async function runAgenticInterventionCommand(subcommand, request, options = {}) {
  if (!['plan', 'arm', 'prepare-computer', 'authorize-computer', 'release-computer'].includes(subcommand)) {
    throw new Error('unknown_agentic_intervention_command');
  }

  if (subcommand === 'authorize-computer') {
    const focusSession = focusSessionInput(request);
    return { ok: true, action: 'computer_use_authorized', authorization: guard(options).authorize(focusSession), focusSession };
  }

  if (subcommand === 'release-computer') {
    const focusSession = focusSessionInput(request);
    return { ok: true, action: 'computer_use_released', release: guard(options).end(focusSession, request.reason ?? 'computer-use-complete') };
  }

  const plan = planAgenticIntervention(request);
  if (subcommand === 'prepare-computer') return computerUsePreparation(request, plan, options);
  if (subcommand === 'plan' || plan.action !== 'notify_user') {
    return { ok: true, action: subcommand === 'arm' ? 'no_notification_needed' : 'planned', plan };
  }
  const arm = options.armNotification ?? armNotification;
  const notification = await arm(plan.notification, options.notificationOptions ?? {});
  return { ok: true, action: 'notification_armed', plan, notification };
}
