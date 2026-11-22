import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=process.env.AICC_TEST_REPO||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=file=>fs.readFileSync(path.join(repo,file),'utf8');
const tray=source('tools/platform/windows/AiccStatusTray.cs');
const panel=source('tools/platform/windows/AiccStatusTrayPanel.cs');
const creditPanel=source('tools/platform/windows/AiccStatusTrayCredits.cs');
const collector=source('tools/platform/windows/tray-status.mjs');
const installer=source('tools/platform/windows/Install-AiccStatusTray.ps1');
const tools=source('tools/platform/windows/AiccStatusTrayTools.cs');

test('tray opens the registered common app and retains the native recovery entry',()=>{
  assert.match(tray,/AICC 앱 열기[^\n]+OpenCommonControl\("overview"\)/);
  assert.match(tray,/공통 도구 열기[^\n]+OpenCommonControl\("tools"\)/);
  assert.match(tray,/PC 상태·복구 열기[^\n]+popup\.Toggle\(\)/);
  assert.match(tools,/if\(panel!="overview"&&panel!="tools"\)/);
  assert.match(tools,/request\.AllowAutoRedirect=false;request\.Proxy=null/);
  assert.match(installer,/CommonControlOnly[\s\S]+Tray baseline changed during common control preparation/);
});

test('tray offers account, credits, diagnostics and policy without leaving the popup',()=>{
  for(const label of ['계정','연결','자동 전환','반영 확인','초기화권'])
    assert.ok(panel.includes(label),'missing direct action '+label);
  for(const label of ['계정으로 돌아가기','목록 새로고침','초기화권','남은','1장 사용'])
    assert.ok(creditPanel.includes(label),'missing credit UI '+label);
  assert.match(tray,/internal sealed partial class StatusPopup : Form/);
  assert.match(tray,/if\(compactReady\)\{PaintExpandedContents/);
  assert.match(installer,/tools\/platform\/windows\/AiccStatusTrayCredits.cs/);
});
test('credit entry selection does not itself issue a reset',()=>{
  assert.match(panel,/resetAccount=MakeButton\(accountActions,"초기화권",OpenCreditInventory\)/);
  assert.doesNotMatch(panel,/ConfirmSelectedReset/);
  assert.match(creditPanel,/void ChooseCredit\(Point location\)/);
  assert.match(creditPanel,/selectedCredit=index/);
  assert.match(creditPanel,/creditAvailable\.Value>0&&CreditUsable\(selectedCredit\)/);
  assert.match(creditPanel,/DateTime\.UtcNow-creditObservedUtc<=TimeSpan\.FromSeconds\(60\)/);
  assert.match(creditPanel,/creditConfirmDeadline=DateTime\.UtcNow\.AddSeconds\(10\)/);
  assert.match(creditPanel,/RunSelected\("reset",null\)/);
  assert.match(creditPanel,/OCX가 결정합니다/);
});
test('stale credit reads cannot override another account, tab or later lookup',()=>{
  assert.match(creditPanel,/creditRequestId=Guid\.NewGuid\(\)\.ToString\("N"\)/);
  assert.match(creditPanel,/S\(result,"requestId",""\)!=creditRequestId/);
  assert.match(creditPanel,/compactPage!=3/);
  assert.match(panel,/if\(compactPage==3&&page!=3\)ClearCreditInventory/);
  assert.match(creditPanel,/!creditVerified\|\|creditBusy/);
});
test('all account changes still use a guarded identity-checked dispatcher',()=>{
  for(const action of ['"use"','"pause"','"resume"','"unpin"','"reset"','"priority"'])
    assert.ok((panel+creditPanel).includes(action),'missing action '+action);
  assert.match(panel,/RequestAccount\(row,action,value\)/);
  assert.match(tray,/popup\.AccountActionRequested=/);
  assert.match(tray,/popup\.ResetCreditsRequested=LookupCredits/);
  assert.match(tray,/LookupCredits\(Dictionary<string,object> row,string requestId\)/);
  assert.match(panel,/PolicyActionRequested\(new Dictionary/);
});
test('credit read-only query authenticates a real selector, not a raw token or credit id',()=>{
  assert.match(collector,/export async function inspectResetCredits/);
  assert.match(collector,/account_identity_changed/);
  assert.match(collector,/--credits/);
  assert.match(collector,/reset-credits\?accountId=/);
  assert.doesNotMatch(collector,/reset-credits\/consume/);
});
test('menu disposal is deferred after click handling to prevent ContextMenuStrip exception',()=>{
  assert.doesNotMatch(tray,/menu\.Closed\+=\(s,e\)=>\{interactions--;menu\.Dispose\(\);\}/);
  assert.ok(tray.includes('BeginInvoke((Action)(()=>{'));
  assert.match(tray,/if\(!menu\.IsDisposed\)menu\.Dispose\(\)/);
  assert.match(tray,/StressMenuLifecycle\(120\)/);
});
test('native glass respects accessibility settings and restores opacity',()=>{
  assert.doesNotMatch(tray,/DwmExtendFrameIntoClientArea/);
  assert.match(tray,/SystemInformation\.HighContrast\|\|SystemInformation\.TerminalServerSession/);
  assert.match(tray,/enabled&&TransparencyAllowed/);
  assert.match(tray,/Opacity-1\.0d/);
  assert.match(tray,/internal void SetTransparency\(bool value\)/);
  assert.match(tray,/popup\.StressTransparency\(100\)/);
});
test('compact account controls remain shared and safe in DPI layouts',()=>{
  assert.match(panel,/CompactWidth=600/);
  assert.match(panel,/CompactRow\{get\{return \(int\)Math\.Ceiling\(136\*textPercent\/100f\)/);
  assert.match(panel,/ClickAccountCard/);
  assert.match(tray,/StressNavigation\(120\)/);
  assert.match(creditPanel,/CreditPageHeight/);
});
test('collector caches default 15 sec visible, 5 min hidden',()=>{
  assert.match(tray,/timer\.Interval=15000/);
  assert.match(tray,/RefreshSeconds=15/);
  assert.match(collector,/displaySeconds=15/);
  assert.match(collector,/visible\?displaySeconds\*1000:300000/);
  assert.doesNotMatch(creditPanel,/Stop-Process|Restart-Service|taskkill|Process.Start/);
});
test('resource measurement is throttled and visible',()=>{
  assert.match(tray,/DateTime\.UtcNow\.AddSeconds\(30\)/);
  assert.match(tray,/UpdateTrayResources\(\)/);
  assert.match(tray,/PrivateMemorySize64/);
  assert.match(panel,/ResourceSummary/);
});
test('policy unsupported mode remains guarded',()=>{
  assert.match(panel,/bool PolicySupported/);
  assert.match(panel,/settingsSupported/);
  assert.match(panel,/!PolicySupported\(\)/);
});

test('credit action resolves the selected account by verified identity',()=>{
  assert.match(panel,/resetAccount=MakeButton\(accountActions,"초기화권",OpenCreditInventory\)/);
  assert.match(panel,/resetAccount\.Enabled=!blocked&&identity/);
  assert.match(creditPanel,/if\(account==null\|\|!Flag\(account,"displayNameVerified"\)\|\|S\(account,"identityHash",""\)\.Length!=64\)return/);
  assert.match(creditPanel,/accountRows.FindIndex\(row=>S\(row,"identityHash",""\)==hash&&S\(row,"selector",""\)==selector/);
  assert.match(creditPanel,/Pick\(index\);OpenCreditInventory\(\)/);
});
test('quota observation stays in fixed footer through pending and notice states',()=>{
  assert.match(panel,/if\(quotaStamp\.Text!=message\)quotaStamp\.Text=message/);
  assert.match(panel,/tips\.SetToolTip\(quotaStamp,LastQuotaText\(\)\+Environment\.NewLine\+LastCollectorText\(\)\)/);
  assert.match(panel,/footer\.Controls\.Add\(quotaStamp\)/);
  assert.match(tray,/refreshDeadlineUtc=DateTime\.UtcNow\.AddSeconds\(70\)/);
  assert.match(tray,/중복 조회 억제/);
  assert.match(tray,/if\(phase=="deferred"\)/);
  assert.match(tray,/CompleteChange\(result\)/);
  assert.match(tray,/--exercise-ui/);
});

test('G1-25 change wait outlasts tray-control steps and adopts only a terminal receipt',()=>{
  const control=source('tools/platform/windows/tray-control.mjs');
  const picker=source('tools/platform/windows/AiccTerminalPickerPanel.cs');
  // preview 90 s + commit 90 s + local sync 50 s + status refresh must fit inside the tray wait.
  assert.match(tray,/exited=p\.WaitForExit\(330000\)/);
  assert.doesNotMatch(tray,/p\.WaitForExit\(190000\)/);
  assert.match(tray,/if\(result==null\|\|!result\.ContainsKey\("terminal"\)\)result=ReadChangeReceipt\(file\+"\.result\.json"\)\?\?result;/);
  assert.match(tray,/terminal=="PASS"\|\|terminal=="HOLD"\|\|terminal=="FAIL"\?value:null/);
  // Busy refresh shows the latest read-only snapshot but keeps controls loading and the change text.
  assert.match(tray,/if\(busy\)\{[\s\S]{0,400}popup\.AcceptSnapshot\(cached\);popup\.Loading=true;popup\.Data\["quotaStatus"\]=status;[\s\S]{0,120}return;\s*\}/);
  for(const key of ['previewMs','commitMs','syncMs','statusMs','totalMs'])assert.match(control,new RegExp('timings\\.'+key+'='));
  assert.match(control,/readFileSync\(resultFile,'utf8'\)===lastReceipt/);
  // Page 6 F5/F1 delegate to the hosted conversation tab.
  assert.match(picker,/internal void LoadRows\(\)\{if\(tabs\.SelectedIndex==1\)continuity\.LoadRows\(\);else terminals\.LoadRows\(true\);\}/);
  assert.match(picker,/internal void ShowHelp\(\)\{if\(tabs\.SelectedIndex==1\)continuity\.ShowHelp\(\);else terminals\.ShowHelp\(\);\}/);
});

test('S-TRAY stale change lock releases only after the change process exits and a settled snapshot',()=>{
  // A timed-out change process stays owned; new changes are refused until it exits.
  assert.match(tray,/else controlRunning=true;/);
  assert.match(tray,/if\(!exited\)\{try\{p\.WaitForExit\(600000\);\}catch\{\}\}/);
  assert.match(tray,/controlRunning=false;lock\(collectorGate\)\{minimumSnapshotUtc=DateTime\.UtcNow;latestData=null;\}SendCollector\("refresh"\);/);
  assert.match(tray,/\(controlRunning&&Convert\.ToString\(request\["action"\]\)!="reconcile"\)/);
  // Release requires: uncertain lock, no running change, complete snapshot, explicit controlNeedsReconcile=false.
  assert.match(tray,/if\(!mutationUncertain\|\|controlRunning\|\|busy\)return;/);
  assert.match(tray,/\(phase!="complete"&&phase!="credits"\)\|\|!data\.TryGetValue\("controlNeedsReconcile",out value\)\|\|!\(value is bool\)\|\|\(bool\)value\)return;/);
  assert.match(tray,/popup\.AcceptSnapshot\(cached\);ReleaseSettledLock\(cached\);/);
  assert.match(tray,/internal void ReleaseChangeLock\(\)\{ControlsLocked=false;/);
});
test('S-TRAY collector re-reads selection after a tray change even during quota cooldown',()=>{
  assert.match(collector,/command\.action==='refresh'\)\{[\s\S]{0,300}statusMemo\.expire\('active:'\);statusMemo\.expire\('pool:'\);/);
});
