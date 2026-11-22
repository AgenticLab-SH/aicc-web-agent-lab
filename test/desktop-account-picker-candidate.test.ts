/** STAGED TESTS. Never run against live A1 accounts or Desktop. */
import { describe, test, expect } from "bun:test";
import {
  makePinnedHighRows, mergeDesktopCatalog, selectExactBoundAccount,
  enforceBoundSolHigh, OWNED_CATALOG_KIND, PickerError,
  type ModelCatalog, type VerifiedAccount,
} from "../tools/platform/opencodex/desktop-account-picker-candidate";

const source: ModelCatalog = {
  fetched_at: "fixture",
  models: [
    {
      slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol",
      visibility: "list", supported_in_api: true, comp_hash: "native-hash",
      context_window: 100000, tool_mode: "code", priority: 4,
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Low" },
        { effort: "medium", description: "Medium" },
        { effort: "high", description: "High" },
        { effort: "xhigh", description: "Extra High" },
      ],
    },
    { slug: "gpt-6-astra", visibility: "list", supported_in_api: true },
    { slug: "chatgpt-web/temporary/high", visibility: "list", default_reasoning_level: "high" },
    { slug: "chatgpt-web/account-2/saved/high", visibility: "list", default_reasoning_level: "high" },
  ],
};
function account(n: number, overrides: Partial<VerifiedAccount> = {}): VerifiedAccount {
  return { selector: "p00000" + n, publicLabel: "계정 " + n, present: true,
    credentialAvailable: true, paused: false, entitledModels: ["gpt-6.1-sol"], ...overrides };
}
function code(error: unknown): string | undefined {
  return error instanceof PickerError ? error.code : undefined;
}

describe("OCX Desktop bound account catalog (isolated)", () => {
  test("four accounts produce four native-compatible High-only rows", () => {
    const rows = makePinnedHighRows(source, [account(1), account(2), account(3), account(4)]);
    expect(rows.length).toBe(4);
    expect(rows.map(r => r.slug)).toEqual([
      "p000001/gpt-6.1-sol", "p000002/gpt-6.1-sol",
      "p000003/gpt-6.1-sol", "p000004/gpt-6.1-sol",
    ]);
    for (const r of rows) {
      expect(r.default_reasoning_level).toBe("high");
      expect(r.supported_reasoning_levels).toEqual([{ effort: "high", description: "High" }]);
      expect(r.context_window).toBe(100000);
      expect(r.comp_hash).toBe("native-hash");
      expect(r.tool_mode).toBe("code");
      expect(r[OWNED_CATALOG_KIND]).toBe(true);
    }
    expect(source.models[0].default_reasoning_level).toBe("low");
  });

  test("main, missing, paused, no credential, unknown model do not get rows", () => {
    const r = [account(1), account(2, { present: false }),
      account(3, { paused: true }), account(4, { credentialAvailable: false }),
      account(5, { entitledModels: null }), account(6, { entitledModels: ["gpt-6-luna"] })];
    expect(makePinnedHighRows(source, r).map(x => x.slug)).toEqual(["p000001/gpt-6.1-sol"]);
    expect(() => makePinnedHighRows(source, [account(1, { selector: "main" })]))
      .toThrow("invalid_public_account_selector");
  });

  test("duplicate selector and raw-email label fail closed", () => {
    expect(() => makePinnedHighRows(source, [account(1), account(2, { selector: "p000001" })]))
      .toThrow("duplicate_account_selector");
    expect(() => makePinnedHighRows(source, [account(1, { publicLabel: "person@example.com" })]))
      .toThrow("unsafe_account_public_label");
  });

  test("merge preserves existing Native/Web model bytes and is idempotent", () => {
    const rows = makePinnedHighRows(source, [account(1), account(2)]);
    const once = mergeDesktopCatalog(source, rows);
    const twice = mergeDesktopCatalog(once, rows);
    expect(twice).toEqual(once);
    expect(once.models.length).toBe(source.models.length + rows.length);
    expect(once.models[0]).toEqual(source.models[0]);
    expect(once.models[1]).toEqual(source.models[1]);
    expect(once.models.slice(-2)).toEqual(source.models.slice(-2));
    expect(once.models[2].slug).toBe("p000001/gpt-6.1-sol");
    expect(source.models).toHaveLength(4);
  });

  test("foreign slug collision cannot replace an existing model", () => {
    const rows = makePinnedHighRows(source, [account(1)]);
    const polluted = structuredClone(source);
    polluted.models.splice(1, 0, { slug: "p000001/gpt-6.1-sol", visibility: "list" });
    expect(() => mergeDesktopCatalog(polluted, rows)).toThrow("incoming_model_invalid_or_collision");
  });
});

describe("exact account routing and wire effort (isolated)", () => {
  const candidates = [{ id: "id-a", priority: 1 }, { id: "id-b", priority: 999 }];

  test("explicit account ignores global priority; does not mutate candidates", () => {
    const before = structuredClone(candidates);
    expect(selectExactBoundAccount("id-a", candidates)).toEqual(candidates[0]);
    expect(candidates).toEqual(before);
    expect(selectExactBoundAccount(undefined, candidates)).toBeNull();
  });

  test("unregistered and previous issuer mismatch refuse before upstream", () => {
    expect(() => selectExactBoundAccount("stale", candidates)).toThrow("bound_pool_account_unavailable");
    expect(() => selectExactBoundAccount("id-b", candidates, "id-a"))
      .toThrow("pinned_thread_account_change_refused");
  });

  test("bound default High uses verified capabilities, no-change for normal pool route", () => {
    const incoming = { model: "p000001/gpt-6.1-sol", input: [], reasoning: { summary: "auto" } };
    const prepared = enforceBoundSolHigh(incoming, "id-a", incoming.model, source.models[0]);
    expect(prepared.reasoning).toEqual({ summary: "auto", effort: "high" });
    expect(incoming.reasoning).toEqual({ summary: "auto" });
    const bare = { model: "gpt-6.1-sol", reasoning: { effort: "low" } };
    expect(enforceBoundSolHigh(bare, undefined, bare.model, source.models[0])).toBe(bare);
  });

  test("explicit native efforts are preserved; mismatched models and unsupported effort refuse", () => {
    for(const effort of ['low','medium','high','xhigh']){
      const incoming={model:'p000001/gpt-6.1-sol',reasoning:{effort}};
      expect(enforceBoundSolHigh(incoming,'id-a',incoming.model,source.models[0]).reasoning).toEqual({effort});
    }
    const invalid={model:'p000001/gpt-6.1-sol',reasoning:{effort:'max'}};
    expect(()=>enforceBoundSolHigh(invalid,'id-a',invalid.model,source.models[0])).toThrow('picker_model_effort_unsupported');
    expect(() => enforceBoundSolHigh({ model: "p000001/gpt-6-luna" }, "id-a", "p000001/gpt-6-luna", source.models[0]))
      .toThrow("picker_qualified_model_mismatch");
  });
  test('native default is used only when High is not supported and capability is valid',()=>{
    const incoming={model:'p000001/gpt-6-luna'};
    const native={slug:'gpt-6-luna',default_reasoning_level:'low',supported_reasoning_levels:[{effort:'low'}]};
    expect(enforceBoundSolHigh(incoming,'id-a',incoming.model,native).reasoning).toEqual({effort:'low'});
    expect(()=>enforceBoundSolHigh(incoming,'id-a',incoming.model,{...native,supported_reasoning_levels:[]})).toThrow('picker_model_efforts_unverified');
    expect(()=>enforceBoundSolHigh({...incoming,reasoning:{effort:null}},'id-a',incoming.model,native)).toThrow('picker_model_effort_unsupported');
  });

  test("error code is stable for callers", () => {
    try { selectExactBoundAccount("id-b", candidates, "id-a"); }
    catch (error) { expect(code(error)).toBe("pinned_thread_account_change_refused"); }
  });
});
