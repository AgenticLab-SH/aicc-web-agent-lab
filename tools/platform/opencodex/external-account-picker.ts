/**
 * AICC external adapter: pure catalog and request helpers.
 * The owner must integrate them through the external OCX adapter and the
 * existing guarded Desktop catalog updater. Never import directly from a
 * running service until that owner has reviewed current source/route/identity.
 */
export const SOL_MODEL = "gpt-6.1-sol";
export const REQUIRED_EFFORT = "high";
export const OWNED_CATALOG_KIND = "aicc-ocx-picker-high-v1";
export const PREFERRED_PREFIX = "preferred-";

type Row = Record<string, unknown>;
export interface ModelCatalog {
  models: Row[];
  [field: string]: unknown;
}
export interface VerifiedAccount {
  selector: string;              // A1 public selector; never the private id
  publicLabel: string;           // trusted, sanitized, non-email display name
  present: boolean;              // exact A1 registered physical pool membership
  credentialAvailable: boolean;
  paused: boolean;
  entitledModels: readonly string[] | null; // account-specific, fresh roster
}
export class PickerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PickerError";
  }
}
const valueIsRecord = (v: unknown): v is Row =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function validateSelector(s: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s)
      || ["main", "__main__", "openai", "chatgpt-web"].includes(s.toLowerCase())) {
    throw new PickerError("invalid_public_account_selector");
  }
}
function safePublicLabel(label: string): string {
  if (typeof label !== "string") throw new PickerError("missing_account_public_label");
  const normalized = label.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > 40 || /[@<>/\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new PickerError("unsafe_account_public_label");
  }
  return normalized;
}
function nativeSol(catalog: ModelCatalog): Row {
  if (!Array.isArray(catalog.models)) throw new PickerError("invalid_native_catalog");
  const source = catalog.models.filter(r => valueIsRecord(r) && r.slug === SOL_MODEL);
  if (source.length !== 1 || source[0].supported_in_api !== true
      || source[0].visibility !== "list") throw new PickerError("sol_model_template_unavailable");
  return source[0];
}
function highLevel(row: Row): Row {
  const levels = row.supported_reasoning_levels;
  const matches = Array.isArray(levels)
    ? levels.filter(v => valueIsRecord(v) && v.effort === REQUIRED_EFFORT)
    : [];
  if (matches.length !== 1) throw new PickerError("sol_high_capability_unverified");
  return structuredClone(matches[0]);
}

/**
 * Makes one exact selector/gpt-6.1-sol row per verified A1 account.
 * Does not grant quota, account entitlements, or duplicate Native/Web models.
 */
export function makePinnedHighRows(
  nativeCatalog: ModelCatalog,
  accounts: readonly VerifiedAccount[],
): Row[] {
  const native = nativeSol(nativeCatalog);
  const high = highLevel(native);
  if (!Array.isArray(accounts) || accounts.length > 32) {
    throw new PickerError("invalid_account_roster");
  }
  const seen = new Set<string>();
  const result: Row[] = [];
  for (const account of accounts) {
    if (!account || typeof account.selector !== "string") {
      throw new PickerError("missing_account_selector");
    }
    validateSelector(account.selector);
    if (seen.has(account.selector)) throw new PickerError("duplicate_account_selector");
    seen.add(account.selector);
    if (account.present !== true || account.credentialAvailable !== true
        || account.paused === true || !Array.isArray(account.entitledModels)
        || !account.entitledModels.includes(SOL_MODEL)) continue;
    const label = safePublicLabel(account.publicLabel);
    const row: Row = structuredClone(native);
    row.slug = account.selector + "/" + SOL_MODEL;
    row.display_name = "OCX · " + label + " · Sol 6.1 · High";
    row.description = "Bound to exactly one OCX account; no automatic account fallback.";
    row.visibility = "list";
    row.default_reasoning_level = REQUIRED_EFFORT;
    row.supported_reasoning_levels = [structuredClone(high)];
    row.priority = 1000 + result.length;
    row[OWNED_CATALOG_KIND] = true;
    result.push(row);
    const preferred: Row = structuredClone(row);
    preferred.slug = PREFERRED_PREFIX + account.selector + "/" + SOL_MODEL;
    preferred.display_name = "OCX · " + label + " 우선 · Sol 6.1 · High";
    preferred.description = "Prefer this OCX account; a completed conversation may continue on an eligible account using readable history. Files, uncertain outcomes and quota stop policy can require a checkpoint or reset wait.";
    preferred.priority = 1100 + result.length;
    result.push(preferred);
  }
  return result;
}
function isOwned(row: Row): boolean {
  return row[OWNED_CATALOG_KIND] === true;
}
function isValidOwnedRow(row: Row): boolean {
  if (!isOwned(row) || typeof row.slug !== "string"
      || !/^(?:preferred-)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/gpt-6\.1-sol$/.test(row.slug)) return false;
  const selector = row.slug.split("/")[0].replace(/^preferred-/, "");
  try { validateSelector(selector); } catch { return false; }
  const levels = row.supported_reasoning_levels;
  return row.default_reasoning_level === REQUIRED_EFFORT
    && Array.isArray(levels) && levels.length === 1
    && valueIsRecord(levels[0]) && levels[0].effort === REQUIRED_EFFORT;
}

/**
 * File-level projection only; caller owns CAS/backup/journal/rollback.
 * Preserve Native/Web model rows exactly and only replace our own marker rows.
 */
export function mergeDesktopCatalog(
  original: ModelCatalog,
  incoming: readonly Row[],
): ModelCatalog {
  if (!Array.isArray(original.models)) throw new PickerError("invalid_desktop_catalog");
  const retained = original.models.filter(r => !valueIsRecord(r) || !isOwned(r));
  if (!retained.every(valueIsRecord) || retained.filter(r => r.slug === SOL_MODEL).length !== 1) {
    throw new PickerError("desktop_native_catalog_corrupt");
  }
  const seen = new Set<string>();
  for (const row of retained) {
    if (typeof row.slug !== "string" || seen.has(row.slug)) {
      throw new PickerError("existing_model_slug_collision");
    }
    seen.add(row.slug);
  }
  const additions: Row[] = [];
  for (const model of incoming) {
    if (!valueIsRecord(model) || !isValidOwnedRow(model) || seen.has(String(model.slug))) {
      throw new PickerError("incoming_model_invalid_or_collision");
    }
    seen.add(String(model.slug));
    additions.push(structuredClone(model));
  }
  const originalRows = retained.map(r => structuredClone(r));
  const firstWeb = originalRows.findIndex(r =>
    typeof r.slug === "string" && r.slug.startsWith("chatgpt-web/"));
  const where = firstWeb < 0 ? originalRows.length : firstWeb;
  return {
    ...structuredClone(original),
    models: [
      ...originalRows.slice(0, where),
      ...additions,
      ...originalRows.slice(where),
    ],
  };
}
export interface PoolAccount { id: string; [field: string]: unknown }

/**
 * Bypass the global active account, priority ceiling, pin and rotation for a
 * truly explicit exact-account route. Caller still MUST enforce fresh quota,
 * physical model entitlement and credential-generation fencing.
 */
export function selectExactBoundAccount<T extends PoolAccount>(
  resolvedAccountId: string | undefined,
  candidates: readonly T[],
  priorIssuerAccountId?: string,
): T | null {
  if (!resolvedAccountId) return null;
  if (priorIssuerAccountId && priorIssuerAccountId !== resolvedAccountId) {
    throw new PickerError("pinned_thread_account_change_refused");
  }
  const exact = candidates.filter(c => c.id === resolvedAccountId);
  if (exact.length !== 1) throw new PickerError("bound_pool_account_unavailable");
  return exact[0];
}

/**
 * Called only after fresh, generation-bound entitlement confirms the exact
 * account's native model. Preserve an explicit supported effort; default to
 * High when available, otherwise the model's verified native default.
 */
export function enforceBoundModelEffort(
  raw: unknown,
  qualifiedAccountId: string | undefined,
  requestedModel: string,
  nativeModel: Row,
): Row {
  if (!valueIsRecord(raw) || typeof raw.model !== "string") {
    throw new PickerError("picker_request_invalid");
  }
  if (!qualifiedAccountId) return raw;
  if (raw.model !== requestedModel
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,198}$/.test(requestedModel)
      || nativeModel?.slug !== requestedModel.split('/')[1]) {
    throw new PickerError("picker_qualified_model_mismatch");
  }
  if (raw.reasoning !== undefined && raw.reasoning !== null && !valueIsRecord(raw.reasoning)) {
    throw new PickerError("picker_reasoning_invalid");
  }
  const reasoning = valueIsRecord(raw.reasoning) ? raw.reasoning : {};
  const levels = nativeModel.supported_reasoning_levels;
  if (!Array.isArray(levels) || !levels.length || !levels.every(level =>
    valueIsRecord(level) && typeof level.effort === 'string'
      && /^[a-z][a-z0-9_-]{0,23}$/.test(level.effort))) {
    throw new PickerError('picker_model_efforts_unverified');
  }
  const efforts = levels.map(level => String(level.effort));
  if (new Set(efforts).size !== efforts.length) throw new PickerError('picker_model_efforts_unverified');
  const effort = reasoning.effort === undefined ? (efforts.includes(REQUIRED_EFFORT)
    ? REQUIRED_EFFORT : nativeModel.default_reasoning_level) : reasoning.effort;
  if (typeof effort !== 'string' || !efforts.includes(effort)) {
    throw new PickerError('picker_model_effort_unsupported');
  }
  return { ...raw, reasoning: { ...reasoning, effort } };
}

// Compatibility export; callers must now provide verified native capability.
export const enforceBoundSolHigh = enforceBoundModelEffort;
