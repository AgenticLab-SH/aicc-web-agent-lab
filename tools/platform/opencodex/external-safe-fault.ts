// AICC-only typed provenance. No request/account data and no raw error messages.
import { PickerError } from './external-account-picker';
export type DispatchEvidence = {
  dispatchStarted: boolean | null;
  source: 'before_supplier' | 'supplier_handoff' | 'provider_fetch_invoked';
  // A budget claim is not proof of a physical send. It never sets dispatchStarted.
  budgetPhysicalClaims?: number | null;
};
export type SafeFailure = {
  code: string; phase: 'pre_dispatch' | 'dispatch_started' | null;
  dispatchStarted: boolean | null; replayed: false;
};
export type FaultProvenance = 'local_guard' | 'roster_unavailable'
  | 'verified_entitlement_rejected' | 'no_admissible_account';
export type ContinuationMode = 'automatic' | 'preferred' | 'strict';
export type ContinuationAdvice = {
  mode: ContinuationMode;
  nextAction: 'checkpoint_new_thread' | 'wait_for_reset';
  sameThreadAccountSwitch: false;
  originalRequestReplay: false;
};
export class ExternalSafeFault extends Error {
  constructor(readonly code:string, readonly provenance:FaultProvenance='local_guard', readonly continuation?:ContinuationAdvice) {
    super(code); this.name='ExternalSafeFault';
  }
}
// Exact prepared e771 receiver allowlist. New internal provenance is not a new wire code.
const codes=new Set([
  'conversation_outcome_unknown','request_outcome_unknown','conversation_request_active','account_change_readable_checkpoint_required',
  'uploaded_files_cannot_change_account','account_change_scrubber_unavailable',
  'bound_pool_account_not_admissible','bound_pool_account_unavailable','pinned_thread_account_change_refused',
  'no_unpaused_pool_account','no_verified_pool_account','native_identity_outside_pool',
  'account_scoped_input_owner_unknown','account_scoped_input_cannot_change_account','picker_request_invalid',
  'picker_qualified_model_mismatch','picker_reasoning_invalid','picker_model_efforts_unverified',
  'picker_model_effort_unsupported','model_required','external_credential_contract_required',
  'external_routed_model_contract_required','quota_unverified','invalid_window_policy',
  'window_policy_unavailable','conversation_binding_capacity','selection_failed','dispatch_failed',
  'external_request_not_completed','maintenance_draining','preferred_account_selector_ambiguous',
  'preferred_pool_account_unavailable','model_entitlement_unverified','model_not_supported_by_account','window_threshold','window_stop_policy',
]);
export function typedFailureCode(error:unknown):string|undefined {
  if(error instanceof ExternalSafeFault) {
    if(error.provenance==='roster_unavailable')return 'model_entitlement_unverified';
    return codes.has(error.code)?error.code:undefined;
  }
  return error instanceof PickerError && codes.has(error.code)?error.code:undefined;
}
export function safeFailure(code:string,started:boolean|null):SafeFailure {
  return {code:codes.has(code)?code:'external_request_not_completed',
    phase:started===true?'dispatch_started':started===false?'pre_dispatch':null,
    dispatchStarted:started===true?true:started===false?false:null,replayed:false};
}
export function failureHeaders(headers:Headers,status:number,failure?:SafeFailure):void {
  for(const key of ['x-aicc-failure-code','x-aicc-failure-phase','x-aicc-dispatch-started'])headers.delete(key);
  if((status!==503 && status!==409) || !failure || !codes.has(failure.code)
    || (failure.dispatchStarted!==false && failure.dispatchStarted!==true)
    || failure.phase!==(failure.dispatchStarted?'dispatch_started':'pre_dispatch'))return;
  headers.set('x-aicc-failure-code',failure.code);
  headers.set('x-aicc-failure-phase',failure.phase);
  headers.set('x-aicc-dispatch-started',String(failure.dispatchStarted));
}
