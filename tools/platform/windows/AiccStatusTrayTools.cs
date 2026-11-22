using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Set the producer before invoking the pinned helper; parent decoding alone is insufficient.
internal static class TrayUtf8Process {
  static string Literal(string value){
    if(value==null||value.IndexOfAny(new[]{'"','\r','\n','\0'})>=0)throw new InvalidOperationException("Invalid helper argument");
    return "'"+value.Replace("'","''")+"'";
  }
  static FileInfo OwnerFile(string path,long limit){
    var file=new FileInfo(path);
    if(!file.Exists||file.Length>limit||(file.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("Registered continuity file unavailable");
    return file;
  }
  // Resolve the installed owner per invocation. A tray snapshot is not a second manager.
  static string RegisteredContinuityHelper(){
    string home=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center");
    string registry=Path.Combine(home,"control-plane","codex-continuity","registrations.json");
    OwnerFile(registry,2097152);
    var cfg=new JavaScriptSerializer{MaxJsonLength=2097152}.Deserialize<Dictionary<string,object>>(File.ReadAllText(registry,new System.Text.UTF8Encoding(false,true)));
    object schema,protocol,pathValue,hashValue;
    if(cfg==null||!cfg.TryGetValue("schemaVersion",out schema)||Convert.ToInt32(schema)!=1||!cfg.TryGetValue("protocolVersion",out protocol)||Convert.ToInt32(protocol)!=3||!cfg.TryGetValue("helperPath",out pathValue)||!cfg.TryGetValue("helperSha256",out hashValue))throw new InvalidOperationException("Registered continuity contract unavailable");
    string hash=Convert.ToString(hashValue),path=Path.GetFullPath(Convert.ToString(pathValue));
    if(!System.Text.RegularExpressions.Regex.IsMatch(hash??"","\\A[a-f0-9]{64}\\z"))throw new InvalidOperationException("Registered continuity pin unavailable");
    string release=Path.Combine(home,"releases","codex-continuity");
    string expected=Path.Combine(release,hash.Substring(0,16),"Invoke-AiccCodexContinuity.ps1");
    if(!String.Equals(path,expected,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Registered continuity path differs");
    for(var directory=new DirectoryInfo(Path.GetDirectoryName(path));directory!=null;directory=directory.Parent){
      if((directory.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("Linked continuity directory refused");
      if(String.Equals(directory.FullName,home,StringComparison.OrdinalIgnoreCase))break;
    }
    OwnerFile(path,2097152);
    using(var stream=File.OpenRead(path))using(var sha=System.Security.Cryptography.SHA256.Create()){
      string actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
      if(!String.Equals(actual,hash,StringComparison.Ordinal))throw new InvalidOperationException("Registered continuity bytes differ");
    }
    return path;
  }
  internal static ProcessStartInfo Helper(string shell,string helper,string action,string id=null,string terminal=null,string messageFile=null,string operation=null){
    helper=RegisteredContinuityHelper();
    string command="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; & "+Literal(helper)+" -Action "+Literal(action);
    if(id!=null)command+=" -ThreadId "+Literal(id);
    if(terminal!=null)command+=" -ExpectedTerminalSha256 "+Literal(terminal);
    if(messageFile!=null)command+=" -MessageFile "+Literal(messageFile)+" -OperationId "+Literal(operation);
    return new ProcessStartInfo(shell,"-NoProfile -NonInteractive -Command \""+command+"\""){
      UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,
      RedirectStandardOutput=true,RedirectStandardError=true,
      StandardOutputEncoding=new System.Text.UTF8Encoding(false,true),StandardErrorEncoding=new System.Text.UTF8Encoding(false,true)
    };
  }
}

// The tray exposes existing owners. It owns no queue, strategy, log or credentials.
internal sealed partial class StatusPopup {
  internal Action<string> ToolRequested;
  internal Action TaskSummaryRequested;
  readonly List<Button> ownerToolButtons=new List<Button>();
  readonly string[] ownerToolKeys={"codex-ocx","codex-native","troubleshoot","rdc","accounts","usage","logs","models","providers","versions","aicc","phone","diagnostics"};
  readonly string[] ownerToolTitles={"Codex CLI · OCX","Codex CLI · Native","AICC 문제 해결","RDC 계정 전환","계정 · 순환 전략","사용 이력","최근 오류","모델 · 라우팅","공급자 설정","설치 · 버전","AICC 관리","휴대폰 연결","진단 복사"};
  readonly string[] ownerToolNotes={"Git 폴더 선택 → OCX 경로로 새 터미널 시작","Git 폴더 선택 → 공식 Native 경로로 새 터미널 시작","연결 진단 · 원 요청 보존 · 준비된 복구 적용","현재 로그인 저장 · 다른 계정 연결 · 전환","OCX · 추가 / 재로그인 / 순환 방식","OCX · 요청 / 모델 / 토큰 사용량","OCX · 오류와 요청 기록","OCX · 모델 선택과 라우팅","OCX · 기존 연결 관리","설치 정보 · OCX 관리 화면","AICC · 목표 / 작업 / 웹 대화","기존 연결 화면 · 일회용 페어링","계정 이름을 가린 현재 관찰값"};
  Button taskManage,taskReload;
  int helpHoverRow=-2;
  readonly List<Dictionary<string,object>> taskRows=new List<Dictionary<string,object>>();
  DateTime taskObserved=DateTime.MinValue,taskAttempt=DateTime.MinValue;
  bool taskReadBusy,taskReadFailed,taskProtocolKnown;
  string taskWorkerState="";
  string PrivateText(string value){
    string text=System.Text.RegularExpressions.Regex.Replace(value??"",@"[\p{Cc}\p{Cf}]"," ");
    foreach(var row in accountRows){string raw=S(row,"name","");if(raw.Length>0)text=text.Replace(raw,AccountLabel(row));}
    int[] elements=System.Globalization.StringInfo.ParseCombiningCharacters(text);
    return elements.Length>120?text.Substring(0,elements[120])+"…":text;
  }
  void InitializeOwnerTools(){
    for(int i=0;i<ownerToolKeys.Length;i++){
      string key=ownerToolKeys[i];var button=MakeButton(contentSurface,ownerToolTitles[i],()=>RequestOwnedTool(key));
      tips.SetToolTip(button,ownerToolNotes[i]);ownerToolButtons.Add(button);
    }
    taskManage=MakeButton(contentSurface,"대화 탭 열기",()=>RequestOwnedTool("tasks"));
    taskReload=MakeButton(contentSurface,"상태 조회",()=>RefreshTaskSummary(true));
    taskManage.AccessibleDescription="대화를 선택해 등록하고 자동재개 켜기·끄기·보류 해제·추적 완료를 관리합니다. 여는 것만으로 작업을 재개하지 않습니다.";
    taskReload.AccessibleDescription="기존 자동재개 등록 상태만 다시 읽습니다. 실제 대화나 계정 설정은 바꾸지 않습니다. 연속 조회는 10초 간격으로 제한합니다.";
    tips.SetToolTip(taskManage,taskManage.AccessibleDescription);tips.SetToolTip(taskReload,taskReload.AccessibleDescription);
    contentSurface.MouseMove+=(s,e)=>{
      if(compactPage!=4)return;int index=((int)(e.Y/scale)-152)/TaskRowHeight();if(e.Y<P(152)||index<0||index>=taskRows.Count)index=-1;
      if(index==helpHoverRow)return;helpHoverRow=index;
      tips.SetToolTip(contentSurface,index<0?"자동재개 등록 현황입니다. 대화 관리에서 등록하거나 켜고 끕니다. F1: 사용법":PrivateText(S(taskRows[index],"title","등록 대화"))+"\n"+TaskState(taskRows[index])+" · "+TaskTime(taskRows[index])+"\n기본 등록은 꺼짐입니다. 대화 관리에서 켜야 재개 조건을 기다립니다. Desktop 연결 대기와 켜짐은 별개입니다.");
    };
    for(int i=0;i<ownerToolButtons.Count;i++)ownerToolButtons[i].AccessibleDescription=ownerToolNotes[i]+". 기존 관리 화면으로 이동합니다. 설정 변경은 해당 화면에서 선택합니다.";
  }
  void ShowFeatureHelp(){
    if(compactPage==9&&cliPage!=null){cliPage.ShowHelp();return;}
    string text=compactPage==4?"재개 현황은 자동재개로 등록한 대화만 보여줍니다. 대화 탭은 대화 검색·등록·전송과 재개 설정을 관리합니다.\n\n대화 관리 → 대화 선택 → 1. 등록 → 2. 자동재개 켜기\n꺼짐: 등록만 됐거나 끈 상태\n대기: 재개 조건을 기다림\n앱 연결 대기: Desktop 전달 연결이 필요함\n확인 필요: 보류 조건을 해결해야 함\n추적 완료: 자동재개 추적만 종료, 실제 목표 상태는 별개\n\n상태 조회는 읽기만 합니다. 버튼 사용법과 잠긴 이유는 대화 관리의 F1에서 확인하세요.":compactPage==5?"도구는 기존 OCX·AICC 관리 화면으로 연결합니다.\n\n계정 · 순환 전략: 자동 선택 방식과 계정 관리\n사용 이력: 요청·모델·토큰 집계\n최근 오류: 기존 요청·오류 로그\n모델 · 라우팅 / 공급자: 기존 설정 화면\n설치 · 버전: 현재 설치 정보와 OCX 대시보드\n휴대폰 연결: 기존 페어링 화면\n진단 복사: 계정 이름을 가린 관찰값 복사\n\n각 버튼에 마우스를 올리거나 Tab으로 이동하면 설명을 볼 수 있습니다.":"계정: 카드를 선택한 뒤 사용·중지·재개를 조작합니다.\n연결: 수집한 연결 상태와 작업 수를 보여줍니다.\n자동 전환: 위·아래로 순서를 바꾸고 저장한 뒤 한도 규칙을 설정합니다.\n작업: 기존 자동재개 등록 상태와 대화 관리\n도구: 기존 OCX·AICC 관리 화면\n\n버튼에 마우스를 올리거나 Tab으로 이동하면 사용법이 표시됩니다. F5: 새로 고침, Esc: 숨기기";
    MessageBox.Show(this,text,"AICC 사용법",MessageBoxButtons.OK,MessageBoxIcon.Information);
  }
  void RequestOwnedTool(string key){
    if(key=="tasks"){SetCompactPage(6);return;}
    if(key=="diagnostics"){CopyStatus();return;}
    if(ToolRequested!=null)ToolRequested(key);else ShowNotice("관리 연결을 확인할 수 없습니다.");
  }
  int ToolRowHeight(){return LogicalContentWidth()-24>=440?Math.Max(64,64*textPercent/100):Math.Max(84,84*textPercent/100);}
  int TaskRowHeight(){return Math.Max(78,78*textPercent/100);}
  int OwnerToolsHeight(){return compactPage==5?88+ownerToolKeys.Length*ToolRowHeight():154+Math.Max(1,taskRows.Count)*TaskRowHeight();}
  void LayoutOwnerTools(){
    if(taskManage==null)return;
    int width=Math.Max(200,LogicalContentWidth()-24);
    taskManage.SetBounds(P(12),P(48),P((width-8)/2),P(34));
    taskReload.SetBounds(P(20+(width-8)/2),P(48),P((width-8)/2),P(34));
    for(int i=0;i<ownerToolButtons.Count;i++)ownerToolButtons[i].SetBounds(P(20),P(91+i*ToolRowHeight()),P(Math.Min(170*textPercent/100,width-24)),P(33*textPercent/100));
  }
  void UpdateOwnerTools(){
    foreach(var button in ownerToolButtons){button.Visible=compactPage==5;button.Enabled=!Loading;}
    if(taskManage==null)return;
    taskManage.Visible=taskReload.Visible=compactPage==4;
    taskReload.Enabled=!taskReadBusy;taskReload.Text=taskReadBusy?"조회 중…":"상태 조회";
    taskManage.Enabled=!Loading;
  }
  void ApplyOwnerToolsAppearance(){
    foreach(var button in ownerToolButtons){button.BackColor=TrayTheme.Surface;button.ForeColor=TrayTheme.Text;}
    if(taskManage!=null)foreach(var button in new[]{taskManage,taskReload}){button.BackColor=TrayTheme.Surface;button.ForeColor=TrayTheme.Text;}
  }
  internal void RefreshTaskSummary(bool force){
    if(compactPage!=4||taskReadBusy||TaskSummaryRequested==null)return;
    double age=(DateTime.UtcNow-taskAttempt).TotalSeconds;
    if(age<(force?10:60))return;
    taskReadBusy=true;taskAttempt=DateTime.UtcNow;UpdateOwnerTools();canvas.Invalidate();TaskSummaryRequested();
  }
  internal void ReceiveTaskSummary(Dictionary<string,object> data){
    taskReadBusy=false;taskReadFailed=data==null;
    if(data!=null){
      taskRows.Clear();taskProtocolKnown=Flag(data,"protocolMatch");
      object workerValue;var worker=data.TryGetValue("worker",out workerValue)?workerValue as Dictionary<string,object>:null;taskWorkerState=worker==null?"":S(worker,"state","");
      object value;var rows=data.TryGetValue("threads",out value)?value as System.Collections.IEnumerable:null;
      if(rows!=null)foreach(object item in rows){var row=item as Dictionary<string,object>;if(row!=null&&taskRows.Count<24)taskRows.Add(row);}
      taskObserved=DateTime.UtcNow;
    }
    UpdateOwnerTools();if(compactPage==4)LayoutExpandedDpi();canvas.Invalidate();
  }
  static string TaskState(Dictionary<string,object> row){
    string state=S(row,"state","");
    if(state=="ARCHIVED_THREAD_HOLD")return "보관됨";
    if(state=="ROLLOUT_MISSING_HOLD")return "기록 없음";
    if(state=="THREAD_SCOPE_HOLD")return "작업 폴더 확인";
    if(state=="THREAD_OBSERVATION_HOLD")return "대화 읽기 보류";
    if(state=="DESKTOP_FAILURE_HOLD")return "전송 오류 보류";
    if(state=="DESKTOP_QUEUE_WAIT")return "공식 전달자 필요";
    if(state=="DELIVERY_UNCERTAIN")return "전달 확인 필요";
    if(state.Contains("HOLD"))return "확인 필요";
    if(state.Contains("RUNNING")||state.Contains("DISPATCH"))return "실행 중";
    if(state.Contains("QUOTA")||state.Contains("RESET"))return "한도 대기";
    if(state.Contains("COMPLETE")||state.Contains("DONE"))return "완료";
    return Flag(row,"enabled")?"대기":"꺼짐";
  }
  string TaskTime(Dictionary<string,object> row){
    DateTime at;string value=S(row,"nextResetAt","");if(String.IsNullOrWhiteSpace(value))value=S(row,"nextCheckAt","");
    return DateTime.TryParse(value,out at)?at.ToUniversalTime().AddHours(9).ToString("MM.dd HH:mm")+" KST":"예정 시각 미확인";
  }
  void PaintOwnerTools(Graphics g){
    int width=LogicalContentWidth()-24;
    TextAt(g,compactPage==4?"재개 현황":"도구",heading,TrayTheme.Text,12,8,width,32);
    if(compactPage==5){
      TextAt(g,"설정과 실행은 기존 관리 화면에서",small,TrayTheme.Muted,12,46,width,24);
      for(int i=0;i<ownerToolButtons.Count;i++){
        int row=ToolRowHeight(),y=84+i*row;Card(g,12,y,width,row-6,false);
        bool wide=width>=440;int left=wide?36+170*textPercent/100:20,top=wide?y+16:y+14+33*textPercent/100;
        TextAt(g,ownerToolNotes[i],small,TrayTheme.Muted,left,top,width-(left-12)-12,24*textPercent/100);
      }
      return;
    }
    string observed=taskObserved==DateTime.MinValue?"아직 조회하지 않았습니다":"조회 "+taskObserved.AddHours(9).ToString("HH:mm:ss")+" KST";
    TextAt(g,taskReadBusy?"기존 등록 상태 조회 중…":taskReadFailed?"조회 지연 · 이전 관찰 유지":observed,small,taskReadFailed?TrayTheme.Warning:TrayTheme.Muted,12,94,width,22);
    TextAt(g,taskObserved!=DateTime.MinValue&&!taskProtocolKnown?"등록 관리기 확인 필요 · 켜기·재개 잠김":taskWorkerState=="WORKER_FAILED"?"감시기 오류 기록 · 등록 설정과 실제 재개는 별개":"상단 대화 탭에서 선택 · 켜기 / 끄기",small,taskObserved!=DateTime.MinValue&&(!taskProtocolKnown||taskWorkerState=="WORKER_FAILED")?TrayTheme.Warning:TrayTheme.Muted,12,118,width,22);
    if(taskRows.Count==0)TextAt(g,taskObserved==DateTime.MinValue?"대화 관리에서 연결 상태를 확인할 수 있습니다.":"등록된 자동재개 작업이 없습니다.",body,TrayTheme.Muted,20,160,width-16,48);
    for(int i=0;i<taskRows.Count;i++){
      var row=taskRows[i];int y=152+i*TaskRowHeight(),stateWidth=110*textPercent/100;string state=TaskState(row);
      Card(g,12,y,width,TaskRowHeight()-6,false,state=="확인 필요");
      TextAt(g,PrivateText(S(row,"title","등록 대화 "+(i+1))),bold,TrayTheme.Text,24,y+5,width-stateWidth-24,28*textPercent/100);
      TextAt(g,state,small,state=="확인 필요"?TrayTheme.Warning:TrayTheme.Muted,width-stateWidth,y+6,stateWidth,26*textPercent/100);
      TextAt(g,(S(row,"executionSurface","")=="desktop"?"Desktop":"기존 등록")+" · 다음 확인 "+TaskTime(row),small,TrayTheme.Muted,24,y+12+28*textPercent/100,width-24,24*textPercent/100);
    }
  }
  internal void PresentOwnedDialog(Form dialog){
    interactions++;
    try{dialog.ShowDialog(this);}finally{interactions--;}
  }
}

internal sealed partial class TrayContext {
  bool ownerToolBusy,taskSummaryBusy,commonControlBusy;
  static string TrayStateRoot(){
    string root=Environment.GetEnvironmentVariable("AICC_STATE_ROOT");
    return Path.GetFullPath(String.IsNullOrWhiteSpace(root)?Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center"):root);
  }
  static string OwnerQuote(string value){if(value==null||value.IndexOfAny(new[]{'"','\r','\n'})>=0)throw new InvalidOperationException();return "\""+value+"\"";}
  static Dictionary<string,object> ReadOwnerJson(string path){
    var file=new FileInfo(path);
    if(!file.Exists||file.Length>2097152||(file.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException();
    return new JavaScriptSerializer{MaxJsonLength=2097152}.Deserialize<Dictionary<string,object>>(File.ReadAllText(path));
  }
  static Uri CommonMobileUri(string value){
    Uri uri;
    if(Uri.TryCreate(value,UriKind.Absolute,out uri)&&uri.Scheme=="http"&&uri.IsLoopback&&
       uri.AbsolutePath=="/mobile.html"&&uri.Query==""&&uri.Fragment==""&&uri.UserInfo=="")return uri;
    return null;
  }
  static Uri RegisteredPublicApp(string owner,string publicOrigin){
    if(String.IsNullOrEmpty(publicOrigin))return null;
    var root=new DirectoryInfo(Path.Combine(owner,"control-plane","mobile-public-runtime"));
    if(!root.Exists||(root.Attributes&FileAttributes.ReparsePoint)!=0)return null;
    var registrations=root.GetDirectories();
    if(registrations.Length>256)throw new InvalidOperationException();
    Uri active=null;
    foreach(var entry in registrations){
      Guid id;
      if(!Guid.TryParseExact(entry.Name,"D",out id)||(entry.Attributes&FileAttributes.ReparsePoint)!=0)continue;
      var config=ReadOwnerJson(Path.Combine(entry.FullName,"runtime.json"));
      if(SnapshotText(config,"runtimeId","")!=entry.Name||SnapshotText(config,"remoteOrigin","")!=publicOrigin)continue;
      var runtime=new DirectoryInfo(Path.Combine(owner,"runtime","mobile-public-control",entry.Name));
      if(!runtime.Exists||(runtime.Attributes&FileAttributes.ReparsePoint)!=0)continue;
      var status=ReadOwnerJson(Path.Combine(runtime.FullName,"status.json"));
      string manifest=SnapshotText(config,"releaseManifestSha256","");
      if(SnapshotText(status,"state","")!="LISTENING"||SnapshotText(status,"runtimeId","")!=entry.Name||
         manifest.Length!=64||SnapshotText(status,"releaseManifestSha256","")!=manifest)continue;
      int pid,port;DateTime started;
      if(!Int32.TryParse(SnapshotText(status,"pid",""),out pid)||!Int32.TryParse(SnapshotText(config,"port",""),out port)||port<1||port>65535||
         !DateTime.TryParse(SnapshotText(status,"startedAt",""),out started))continue;
      try{using(var process=Process.GetProcessById(pid)){
        if(process.HasExited||!process.ProcessName.Equals("node",StringComparison.OrdinalIgnoreCase)||
           Math.Abs((process.StartTime.ToUniversalTime()-started.ToUniversalTime()).TotalSeconds)>60)continue;
      }}catch(ArgumentException){continue;}
      if(active!=null)throw new InvalidOperationException();
      active=new Uri("http://127.0.0.1:"+port+"/mobile.html");
    }
    return active;
  }
  internal static Uri ResolveCommonControl(string owner,string panel){
    if(panel!="overview"&&panel!="tools")throw new ArgumentException("Unknown common control panel.");
    var config=ReadOwnerJson(Path.Combine(owner,"control-plane","mobile-control.json"));
    Uri uri=RegisteredPublicApp(owner,SnapshotText(config,"publicOrigin",""))??CommonMobileUri(SnapshotText(config,"localUrl",""));
    if(uri==null)throw new InvalidOperationException();
    var request=(System.Net.HttpWebRequest)System.Net.WebRequest.Create(uri);
    request.Timeout=3000;request.ReadWriteTimeout=3000;request.AllowAutoRedirect=false;request.Proxy=null;
    using(var response=(System.Net.HttpWebResponse)request.GetResponse())using(var reader=new StreamReader(response.GetResponseStream(),System.Text.Encoding.UTF8)){
      var buffer=new char[262145];int length=reader.ReadBlock(buffer,0,buffer.Length);
      string html=new string(buffer,0,length);
      if(response.StatusCode!=System.Net.HttpStatusCode.OK||length==buffer.Length||!html.Contains("id=\"overview\"")||!html.Contains("id=\"toolGroups\""))throw new InvalidOperationException();
    }
    return new UriBuilder(uri){Fragment=panel}.Uri;
  }
  void OpenCommonControl(string panel){
    if(commonControlBusy)return;
    commonControlBusy=true;
    ThreadPool.QueueUserWorkItem(_=>{
      bool opened=false;
      try{Uri uri=ResolveCommonControl(TrayStateRoot(),panel);Process.Start(new ProcessStartInfo(uri.AbsoluteUri){UseShellExecute=true});opened=true;}catch{}
      if(exiting||popup.IsDisposed)return;
      try{popup.BeginInvoke((Action)(()=>{
        commonControlBusy=false;
        if(opened)return;
        if(!popup.Visible)popup.Toggle();else popup.Activate();
        popup.ShowNotice("AICC 앱에 연결하지 못했습니다. 이 창의 도구 → AICC 문제 해결을 이용하세요.");
      }));}catch(InvalidOperationException){}
    });
  }
  void OwnerFeedback(string message){if(exiting||popup.IsDisposed)return;try{popup.BeginInvoke((Action)(()=>popup.ShowNotice(message)));}catch(InvalidOperationException){}}
  void ReadTaskSummary(){
    if(taskSummaryBusy){popup.ReceiveTaskSummary(null);return;}taskSummaryBusy=true;
    ThreadPool.QueueUserWorkItem(_=>{
      Dictionary<string,object> result=null;
      try{
        string helper=Path.Combine(source,"tools","platform","windows","Invoke-AiccCodexContinuity.ps1");
        string shell=Path.Combine(TrayStateRoot(),"toolchain","pwsh-7.6.6","runtime","pwsh.exe");
        if(!File.Exists(helper)||!File.Exists(shell))throw new InvalidOperationException();
        using(var process=Process.Start(TrayUtf8Process.Helper(shell,helper,"Status"))){
          var output=process.StandardOutput.ReadToEndAsync();var error=process.StandardError.ReadToEndAsync();
          if(!process.WaitForExit(30000)){try{process.Kill();}catch{}throw new InvalidOperationException();}
          if(process.ExitCode!=0||output.Result.Length>262144)throw new InvalidOperationException();
          result=new JavaScriptSerializer{MaxJsonLength=262144}.Deserialize<Dictionary<string,object>>(output.Result);
        }
      }catch{}
      taskSummaryBusy=false;if(exiting||popup.IsDisposed)return;
      try{popup.BeginInvoke((Action)(()=>popup.ReceiveTaskSummary(result)));}catch(InvalidOperationException){}
    });
  }
  void OpenOwnedTool(string key){
    if(key=="tasks"){popup.SelectPreviewPage(6);return;}
    if(key=="codex-ocx"||key=="codex-native"){
      popup.OpenCliPage(key=="codex-ocx"?"ocx":"native");
      return;
    }
    if(key=="troubleshoot"||key=="rdc"){
      string helper=Path.Combine(source,"tools","platform","windows","Invoke-AiccTroubleshooter.ps1");
      string shell=Path.Combine(TrayStateRoot(),"toolchain","pwsh-7.6.6","runtime","pwsh.exe");
      using(var dialog=new AiccOperationsDialog(key=="rdc",helper,shell))popup.PresentOwnedDialog(dialog);
      return;
    }
    if(ownerToolBusy){popup.ShowNotice("기존 관리 화면 준비 중입니다.");return;}
    ownerToolBusy=true;popup.ShowNotice("기존 관리 화면을 엽니다.");
    string selectedKey=key;
    ThreadPool.QueueUserWorkItem(_=>{
      try{
        string page=selectedKey=="accounts"?"codex-auth":selectedKey=="versions"?"dashboard":selectedKey;
        if(Array.IndexOf(new[]{"codex-auth","usage","logs","models","providers","dashboard"},page)>=0){
          string launcher=Path.Combine(source,"tools","platform","opencodex","Open-AiccOcxDashboard.ps1");
          using(var p=Process.Start(Hidden("pwsh.exe","-NoProfile -NonInteractive -File "+OwnerQuote(launcher)+" -Page "+page))){
            var output=p.StandardOutput.ReadToEndAsync();var error=p.StandardError.ReadToEndAsync();
            if(!p.WaitForExit(30000)){try{p.Kill();}catch{}throw new InvalidOperationException();}
            if(p.ExitCode!=0)throw new InvalidOperationException();
          }
          OwnerFeedback(selectedKey=="versions"?InstalledVersions()+" · OCX 화면 열기 전달":"OCX 관리 화면 열기 전달");
        }else if(selectedKey=="aicc"){
          OpenExistingAicc();OwnerFeedback("AICC 관리 화면 열기 전달");
        }else if(selectedKey=="phone"){
          var config=ReadOwnerJson(Path.Combine(TrayStateRoot(),"control-plane","mobile-control.json"));Uri uri;
          if(!Uri.TryCreate(SnapshotText(config,"localUrl",""),UriKind.Absolute,out uri)||uri.Scheme!="http"||!uri.IsLoopback||uri.AbsolutePath!="/mobile.html"||uri.Query!=""||uri.Fragment!=""||uri.UserInfo!="")throw new InvalidOperationException();
          Process.Start(new ProcessStartInfo(uri.AbsoluteUri){UseShellExecute=true});OwnerFeedback("기존 휴대폰 연결 화면 열기 전달");
        }else throw new InvalidOperationException();
      }catch{OwnerFeedback("관리 화면을 열지 못했습니다. 기존 연결과 설치 상태를 확인하세요.");}
      finally{ownerToolBusy=false;}
    });
  }
  string InstalledVersions(){
    try{
    var registry=ReadOwnerJson(Path.Combine(TrayStateRoot(),"runtime","components.json"));object components,value;
    var parts=registry.TryGetValue("components",out components)?components as Dictionary<string,object>:null;
    var tray=parts!=null&&parts.TryGetValue("tray",out value)?value as Dictionary<string,object>:null;
    string release=SnapshotText(tray,"releaseHash","미확인");if(release.Length>12)release=release.Substring(0,12);
    return "트레이 "+release;
    }catch{return "트레이 버전 미확인";}
  }
  void OpenExistingAicc(){
    // Follow the existing CLI host/port contract, without its implicit server start.
    string host=Environment.GetEnvironmentVariable("AICC_HOST");if(String.IsNullOrWhiteSpace(host))host="127.0.0.1";
    string configuredPort=Environment.GetEnvironmentVariable("AICC_PORT");int port=4381;
    if(!String.IsNullOrWhiteSpace(configuredPort)&&!Int32.TryParse(configuredPort,out port))throw new InvalidOperationException();
    Uri url;if(port<1||port>65535||!Uri.TryCreate("http://"+host+":"+port+"/",UriKind.Absolute,out url)||!url.IsLoopback||url.UserInfo!=""||url.AbsolutePath!="/")throw new InvalidOperationException();
    var request=(System.Net.HttpWebRequest)System.Net.WebRequest.Create(new Uri(url,"healthz"));
    request.Timeout=3000;request.ReadWriteTimeout=3000;request.AllowAutoRedirect=false;request.Proxy=null;
    using(var response=(System.Net.HttpWebResponse)request.GetResponse())using(var reader=new StreamReader(response.GetResponseStream())){
      var buffer=new char[4097];int length=reader.ReadBlock(buffer,0,buffer.Length);
      if(response.StatusCode!=System.Net.HttpStatusCode.OK||length>4096)throw new InvalidOperationException();
      var health=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(new string(buffer,0,length));
      if(SnapshotText(health,"mode","")!="local-control"||!health.ContainsKey("ok")||!Object.Equals(health["ok"],true))throw new InvalidOperationException();
    }
    Process.Start(new ProcessStartInfo(url.AbsoluteUri){UseShellExecute=true});
  }
}
