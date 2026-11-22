export const PROJECT_PROGRESS_WEIGHTS = Object.freeze({
  discovery: 10,
  design: 15,
  implementation: 35,
  automatedVerification: 20,
  userAcceptance: 10,
  releaseOperation: 10
});

const GATE_STATUSES = new Set(['PASS', 'PARTIAL', 'UNKNOWN', 'FAIL', 'N/A']);

export class ProjectProgressError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectProgressError';
    this.code = code;
  }
}

function normalizeStatus(value) {
  const normalized = String(value ?? 'UNKNOWN').trim().toUpperCase().replaceAll('_', '/');
  if (normalized === 'NA' || normalized === 'NOT/APPLICABLE') return 'N/A';
  if (!GATE_STATUSES.has(normalized)) {
    throw new ProjectProgressError('invalid_gate_status', `unsupported project progress gate status: ${String(value)}`);
  }
  return normalized;
}

function normalizeEvidenceRefs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(ref => typeof ref !== 'string' || !ref.trim())) {
    throw new ProjectProgressError('invalid_evidence_refs', 'gate evidenceRefs must be an array of non-empty references');
  }
  return [...new Set(value.map(ref => ref.trim()))];
}

function normalizeGate(name, weight, gate) {
  const source = gate && typeof gate === 'object' && !Array.isArray(gate) ? gate : { status: gate };
  const status = normalizeStatus(source.status);
  const evidenceRefs = normalizeEvidenceRefs(source.evidenceRefs);
  const applicable = status !== 'N/A';
  const current = source.current === true;
  const credited = applicable && status === 'PASS' && current && evidenceRefs.length > 0;
  let excludedReason = null;
  if (!applicable) excludedReason = 'not-applicable';
  else if (status !== 'PASS') excludedReason = `status-${status.toLowerCase()}`;
  else if (!current) excludedReason = 'current-evidence-required';
  else if (evidenceRefs.length === 0) excludedReason = 'evidence-reference-required';
  return { name, weight, status, applicable, current, evidenceRefs, credited, excludedReason };
}

function normalizeManualOverride(value, originalPercent) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectProgressError('invalid_manual_override', 'manual override must be an object');
  }
  const percent = Number(value.percent);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new ProjectProgressError('invalid_manual_override', 'manual override percent must be an integer from 0 to 100');
  }
  const reason = String(value.reason ?? '').trim();
  const actor = String(value.actor ?? '').trim();
  const at = String(value.at ?? '').trim();
  if (!reason || !actor || !at || Number.isNaN(Date.parse(at))) {
    throw new ProjectProgressError('invalid_manual_override', 'manual override requires reason, actor, and an ISO timestamp');
  }
  return { percent, originalPercent, reason, actor, at: new Date(at).toISOString() };
}

export function computeProjectProgress({ gates = {}, manualOverride = null } = {}) {
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) {
    throw new ProjectProgressError('invalid_gates', 'project progress gates must be an object');
  }
  const normalizedGates = Object.fromEntries(Object.entries(PROJECT_PROGRESS_WEIGHTS).map(([name, weight]) => {
    return [name, normalizeGate(name, weight, gates[name])];
  }));
  const applicable = Object.values(normalizedGates).filter(gate => gate.applicable);
  const denominator = applicable.reduce((total, gate) => total + gate.weight, 0);
  const credited = applicable.filter(gate => gate.credited);
  const numerator = credited.reduce((total, gate) => total + gate.weight, 0);
  const percent = denominator === 0 ? 0 : Math.round((numerator / denominator) * 100);
  const allVerified = denominator > 0 && credited.length === applicable.length;
  const allUnknown = credited.length === 0 && applicable.every(gate => gate.status === 'UNKNOWN');
  const confidence = allVerified ? 'verified' : allUnknown || denominator === 0 ? 'unknown' : 'partial';
  const evidenceRefs = [...new Set(credited.flatMap(gate => gate.evidenceRefs))];
  const computed = {
    percent,
    numerator,
    denominator,
    confidence,
    gates: normalizedGates
  };
  const override = normalizeManualOverride(manualOverride, percent);
  return {
    percent: override?.percent ?? percent,
    method: override ? 'manual-override' : 'weighted-gates',
    confidence,
    evidenceRefs,
    computed,
    override
  };
}
