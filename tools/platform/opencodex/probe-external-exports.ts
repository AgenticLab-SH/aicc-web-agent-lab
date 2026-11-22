import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=process.env.AICC_OCX_SUPPLIER_ROOT;
if(!root || !process.env.OPENCODEX_HOME || !process.env.CODEX_HOME) throw Error('isolated-export-fixture-required');
globalThis.fetch=async()=>{throw Error('network-forbidden-in-export-fixture');};
const contracts:Record<string,string[]>={
 'src/index.ts':['parseRequest','createResponsesPassthroughAdapter'],
 'src/lib/translator-budget.ts':['createTranslatorBudget','finalizeTranslatorBudgetResponse'],
 'src/codex/quota.ts':['parseUsageQuota'],
 'src/server/responses/account-change-state.ts':['collectConversationStateCarriers','scrubUnportableConversationStateInPlace'],
 'src/router.ts':['previewRouteModel'],
 'src/adapters/openai-responses.ts':[],
 'src/server/ws-bridge.ts':['sendResponseToWebSocket','buildWarmupCompletionFrames'],
 'src/server/responses/core.ts':['handleResponses'],
 'src/server/responses/compact.ts':['handleResponsesCompact'],
 'src/lib/request-execution-budget.ts':['createRequestExecutionBudget'],
 'src/server/request-log.ts':['nextRequestLogId'],
 'src/codex/catalog/build-entries.ts':['buildCatalogEntriesFromObservedState'],
 'src/server/fast-row.ts':['parseSyntheticRowId','expandFastRow','catalogFastRowEligible'],
 'src/server/responses/core-opaque-recovery.ts':['prepareOpaqueBlobRecovery'],
 'src/server/search.ts':['handleSearch'],
 'src/codex/control-plane-models.ts':['isCodexControlPlaneModel'],
 'src/codex/catalog/control-plane.ts':['withCodexControlPlaneRows'],
 'src/client/machine-listener.ts':['startMachineListener'],
};
const rows=[];
for(const [path,names] of Object.entries(contracts)){
 const module=await import(pathToFileURL(join(root,path)).href);
 for(const name of names) assert.equal(typeof module[name],'function',path+':'+name);
 rows.push({path,functions:names,sha256:createHash('sha256').update(readFileSync(join(root,path))).digest('hex')});
}
console.log(JSON.stringify({status:'PASS',scope:'actual-imported-exports',supplierVersion:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,network:'forbidden',rows}));