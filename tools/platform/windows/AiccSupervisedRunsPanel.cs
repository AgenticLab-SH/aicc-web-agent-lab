using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// 관제 실행 패널. 상태·변경은 로컬 AICC 서버의 /api/mobile/supervise* 하나만 쓴다(127.0.0.1, 모바일 세션·CSRF).
// 이 패널은 상태 파일을 직접 쓰지 않는다. 변경은 서버 미리보기 → 확인 대화상자 → 한 번 실행이며, 응답이 끊기면 다시 보내지 않는다.
// .NET Framework csc(C# 5) 호환: 문자열 보간·?.·식 본문 멤버를 쓰지 않는다.
internal sealed class AiccSupervisedRunsPanel : Form {
  static AiccSupervisedRunsPanel instance;
  internal static void ShowSingleton(){
    if(instance==null||instance.IsDisposed)instance=new AiccSupervisedRunsPanel();
    if(!instance.Visible)instance.Show();
    if(instance.WindowState==FormWindowState.Minimized)instance.WindowState=FormWindowState.Normal;
    instance.Activate();
  }

  readonly int port;
  readonly CookieContainer cookies=new CookieContainer();
  readonly JavaScriptSerializer json=new JavaScriptSerializer{MaxJsonLength=8388608};
  string csrf;bool busy;
  Dictionary<string,object> status;
  readonly ComboBox runs=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Width=260};
  readonly Button refresh=new DarkTrayButton{Text="새로 조회",AutoSize=true};
  readonly Label summary=new Label{AutoSize=true,Padding=new Padding(0,6,0,0)};
  readonly ListView groups=new ListView{View=View.Details,FullRowSelect=true,HideSelection=false,MultiSelect=false,Dock=DockStyle.Fill};
  readonly Button logs=new DarkTrayButton{Text="로그 보기",AutoSize=true,Enabled=false};
  readonly Button closeTab=new DarkTrayButton{Text="탭 닫기",AutoSize=true,Enabled=false};
  readonly Button endGroup=new DarkTrayButton{Text="그룹 종료",AutoSize=true,Enabled=false};
  readonly Button wake=new DarkTrayButton{Text="결과 전달 · 한 번 깨우기",AutoSize=true,Enabled=false};
  readonly Button web=new DarkTrayButton{Text="웹 화면 열기",AutoSize=true};
  readonly Label reason=new Label{AutoSize=true,Padding=new Padding(0,6,0,0)};
  readonly Label state=new Label{Dock=DockStyle.Bottom,Height=26,TextAlign=ContentAlignment.MiddleLeft,Padding=new Padding(8,0,8,0)};
  readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer{Interval=30000};

  AiccSupervisedRunsPanel(){
    port=ResolvePort();
    Text="AICC 관제 실행";StartPosition=FormStartPosition.CenterScreen;MinimumSize=new Size(620,420);Size=new Size(820,540);
    Font=new Font(TrayTheme.TextFont,10f);BackColor=TrayTheme.Background;ForeColor=TrayTheme.Text;KeyPreview=true;
    foreach(var b in new[]{refresh,logs,closeTab,endGroup,wake,web}){b.FlatStyle=FlatStyle.Flat;b.FlatAppearance.BorderColor=TrayTheme.Edge;b.BackColor=TrayTheme.Surface;b.ForeColor=TrayTheme.Text;b.MinimumSize=new Size(0,34);b.Margin=new Padding(0,0,8,0);}
    groups.BackColor=TrayTheme.Surface;groups.ForeColor=TrayTheme.Text;groups.BorderStyle=BorderStyle.FixedSingle;
    groups.Columns.Add("그룹",90);groups.Columns.Add("실행기",120);groups.Columns.Add("상태",120);groups.Columns.Add("마지막 PROGRESS",150);groups.Columns.Add("마지막 차례 끝",150);
    summary.ForeColor=TrayTheme.Muted;reason.ForeColor=TrayTheme.Muted;state.ForeColor=TrayTheme.Muted;state.BackColor=TrayTheme.Surface;
    var top=new FlowLayoutPanel{Dock=DockStyle.Top,AutoSize=true,Padding=new Padding(10,10,10,4),WrapContents=true};
    top.Controls.Add(new Label{Text="실행",AutoSize=true,Padding=new Padding(0,7,6,0)});top.Controls.Add(runs);top.Controls.Add(refresh);top.Controls.Add(summary);
    var bottom=new FlowLayoutPanel{Dock=DockStyle.Bottom,AutoSize=true,Padding=new Padding(10,6,10,6),WrapContents=true};
    bottom.Controls.Add(logs);bottom.Controls.Add(closeTab);bottom.Controls.Add(endGroup);bottom.Controls.Add(wake);bottom.Controls.Add(web);bottom.Controls.Add(reason);
    reason.MaximumSize=new Size(580,0);
    var middle=new Panel{Dock=DockStyle.Fill,Padding=new Padding(10,4,10,4)};middle.Controls.Add(groups);
    Controls.Add(middle);Controls.Add(bottom);Controls.Add(top);Controls.Add(state);
    refresh.Click+=delegate{Reload();};
    runs.SelectedIndexChanged+=delegate{RenderRun();};
    groups.SelectedIndexChanged+=delegate{UpdateButtons();};
    logs.Click+=delegate{ShowLogs();};
    closeTab.Click+=delegate{Change("close-tab",false);};
    endGroup.Click+=delegate{Change("end-group",true);};
    wake.Click+=delegate{Change("wake-group",false);};
    web.Enabled=port>0;
    web.Click+=delegate{try{Process.Start(new ProcessStartInfo("http://127.0.0.1:"+port+"/supervise.html"){UseShellExecute=true});}catch(Exception error){Notice("웹 화면 열기 실패 · "+error.Message);}};
    KeyDown+=(s,e)=>{if(e.KeyCode==Keys.F5){Reload();e.Handled=true;}else if(e.KeyCode==Keys.Escape){Hide();e.Handled=true;}};
    FormClosing+=(s,e)=>{if(e.CloseReason==CloseReason.UserClosing){e.Cancel=true;Hide();}};
    VisibleChanged+=delegate{if(Visible){timer.Start();Reload();}else timer.Stop();};
    timer.Tick+=delegate{if(!busy)Reload();};
  }

  static int ResolvePort(){
    try{
      string owner=Environment.GetEnvironmentVariable("AICC_STATE_ROOT");
      if(String.IsNullOrWhiteSpace(owner))owner=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center");
      string file=Path.Combine(owner,"control-plane","mobile-control.json");var info=new FileInfo(file);
      if(!info.Exists||info.Length>65536||(info.Attributes&FileAttributes.ReparsePoint)!=0)return 0;
      var config=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8));Uri uri;
      if(!Uri.TryCreate(Str(config,"localUrl"),UriKind.Absolute,out uri)||uri.Scheme!="http"||!uri.IsLoopback||uri.AbsolutePath!="/mobile.html"||uri.Query!=""||uri.Fragment!=""||uri.UserInfo!="")return 0;
      return uri.Port;
    }catch{return 0;}
  }
  void Notice(string text){state.Text=text;}
  void SetBusy(bool on,string text){busy=on;refresh.Enabled=!on;UseWaitCursor=on;if(text!=null)Notice(text);if(on){logs.Enabled=closeTab.Enabled=endGroup.Enabled=wake.Enabled=false;}else UpdateButtons();}

  Dictionary<string,object> Call(string method,string route,object body){
    if(port==0)throw new InvalidOperationException("등록된 로컬 모바일 제어 주소가 없습니다. 기존 AICC 연결 설정을 확인하세요.");
    var request=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:"+port+"/api/mobile/"+route);
    request.Method=method;request.CookieContainer=cookies;request.Timeout=20000;request.ReadWriteTimeout=20000;request.Proxy=null;
    request.Headers["Origin"]="http://127.0.0.1:"+port;
    if(body!=null){
      request.ContentType="application/json";if(csrf!=null)request.Headers["x-aicc-csrf"]=csrf;
      byte[] bytes=new UTF8Encoding(false).GetBytes(json.Serialize(body));request.ContentLength=bytes.Length;
      using(var stream=request.GetRequestStream())stream.Write(bytes,0,bytes.Length);
    }
    HttpWebResponse response;
    try{response=(HttpWebResponse)request.GetResponse();}
    catch(WebException error){response=error.Response as HttpWebResponse;if(response==null)throw new InvalidOperationException(body==null?"AICC 로컬 서버에 연결하지 못했습니다.":"응답 연결이 끊겼습니다. 다시 보내지 말고 새로 조회해 결과를 확인하세요.");}
    using(response)using(var reader=new StreamReader(response.GetResponseStream(),new UTF8Encoding(false))){
      var data=json.Deserialize<Dictionary<string,object>>(reader.ReadToEnd())??new Dictionary<string,object>();
      object ok;
      if((int)response.StatusCode>=400||(data.TryGetValue("ok",out ok)&&ok is bool&&!(bool)ok)){
        string message=Str(data,"error");string code=Str(data,"code");
        throw new SuperviseCallException(String.IsNullOrEmpty(message)?("처리할 수 없습니다 · "+(String.IsNullOrEmpty(code)?"결과 미확인":code)):message,code,data);
      }
      return data;
    }
  }
  void EnsureSession(){
    if(csrf!=null)return;
    var value=Call("POST","local-session",new Dictionary<string,object>());
    csrf=Str(value,"csrf");
  }
  void Background(string text,Action work){Background(text,work,null);}
  void Background(string text,Action work,Action after){
    if(busy)return;SetBusy(true,text);
    ThreadPool.QueueUserWorkItem(_=>{
      string error=null;
      try{work();}catch(Exception e){error=e.Message;}
      try{BeginInvoke((Action)(()=>{SetBusy(false,null);if(error!=null)Notice(error);if(after!=null)after();}));}catch(InvalidOperationException){}
    });
  }

  void Reload(){Reload(null);}
  void Reload(string prefix){
    Background(prefix??"불러오는 중…",()=>{
      try{EnsureSession();}catch{csrf=null;throw;}
      Dictionary<string,object> value;
      try{value=Call("GET","supervise",null);}
      catch(SuperviseCallException e){if(e.Code=="csrf_required"||e.Code=="pair_required"){csrf=null;EnsureSession();value=Call("GET","supervise",null);}else throw;}
      BeginInvoke((Action)(()=>{status=value;RenderRuns();Notice((prefix==null?"":prefix+" · ")+"조회 "+Kst(Str(value,"generatedAt"))+" · 30초마다 갱신 · F5 새로 조회");}));
    });
  }

  static IEnumerable<Dictionary<string,object>> Items(Dictionary<string,object> data,string key){
    object value;
    if(data==null||!data.TryGetValue(key,out value)||!(value is IEnumerable)||value is string)yield break;
    foreach(var item in (IEnumerable)value){var row=item as Dictionary<string,object>;if(row!=null)yield return row;}
  }
  static string Str(Dictionary<string,object> data,string key){object v;return data!=null&&data.TryGetValue(key,out v)&&v!=null?Convert.ToString(v):"";}
  static bool Flag(Dictionary<string,object> data,string key){object v;return data!=null&&data.TryGetValue(key,out v)&&v is bool&&(bool)v;}
  static string Kst(string iso){
    DateTimeOffset at;if(String.IsNullOrEmpty(iso)||!DateTimeOffset.TryParse(iso,out at))return "-";
    return at.ToOffset(TimeSpan.FromHours(9)).ToString("MM-dd HH:mm");
  }

  readonly List<Dictionary<string,object>> runRows=new List<Dictionary<string,object>>();
  void RenderRuns(){
    string keep=runs.SelectedIndex>=0&&runs.SelectedIndex<runRows.Count?Str(runRows[runs.SelectedIndex],"opsDirectory"):null;
    runRows.Clear();runs.BeginUpdate();runs.Items.Clear();
    foreach(var run in Items(status,"runs")){runRows.Add(run);runs.Items.Add(Str(run,"runName")+(run.ContainsKey("error")?" (읽기 실패)":""));}
    runs.EndUpdate();
    if(runRows.Count==0){summary.Text="관제 실행 없음";groups.Items.Clear();UpdateButtons();return;}
    int index=runRows.FindIndex(r=>Str(r,"opsDirectory")==keep);runs.SelectedIndex=index>=0?index:0;
    RenderRun();
  }
  Dictionary<string,object> CurrentRun(){return runs.SelectedIndex>=0&&runs.SelectedIndex<runRows.Count?runRows[runs.SelectedIndex]:null;}
  void RenderRun(){
    var run=CurrentRun();
    string keep=groups.SelectedItems.Count>0?groups.SelectedItems[0].Text:null;
    groups.BeginUpdate();groups.Items.Clear();
    if(run!=null){
      summary.Text="기한 "+Kst(Str(run,"deadline"))+(Flag(run,"deadlinePassed")?" (지남)":"")+" · 마지막 깨우기 "+Kst(Str(run,"lastWakeAt"));
      object s0;if(run.TryGetValue("s0",out s0)&&s0 is Dictionary<string,object>)AddRow((Dictionary<string,object>)s0,true);
      foreach(var g in Items(run,"groups"))AddRow(g,false);
      foreach(var g in Items(run,"endedGroups"))AddRow(g,false);
    }
    groups.EndUpdate();
    if(keep!=null)foreach(ListViewItem item in groups.Items)if(item.Text==keep){item.Selected=true;item.Focused=true;break;}
    UpdateButtons();
  }
  void AddRow(Dictionary<string,object> g,bool s0){
    string st=Str(g,"state");
    var item=new ListViewItem(new[]{s0?"S0":Str(g,"name"),Str(g,"runner")+(Flag(g,"elevated")?" · 관리자":""),Str(g,"stateLabel"),Kst(Str(g,"lastProgressAt")),Kst(Str(g,"lastTurnEndAt"))}){Tag=g};
    item.UseItemStyleForSubItems=false;
    var cell=item.SubItems[2];
    cell.ForeColor=st=="turn_active"?TrayTheme.Good:(st=="crashed"||st=="stale"||st=="not_found")?TrayTheme.Warning:(st=="ended"||st=="unopened")?TrayTheme.Muted:TrayTheme.Text;
    if(s0)item.Name="S0";
    groups.Items.Add(item);
  }
  Dictionary<string,object> Selected(){return groups.SelectedItems.Count>0?groups.SelectedItems[0].Tag as Dictionary<string,object>:null;}
  void UpdateButtons(){
    var g=Selected();bool isS0=groups.SelectedItems.Count>0&&groups.SelectedItems[0].Name=="S0";
    if(busy)return;
    if(g==null){logs.Enabled=closeTab.Enabled=endGroup.Enabled=wake.Enabled=false;reason.Text="그룹을 고르면 상태·전달 근거와 사용 가능한 동작을 확인합니다.";return;}
    string st=Str(g,"state");
    logs.Enabled=true;
    bool codex=Str(g,"runner")=="codex";
    bool canClose=!codex&&!isS0&&Str(g,"sessionId")!=""&&st!="turn_active"&&st!="stale"&&Flag(g,"tabOpen");
    closeTab.Enabled=canClose;endGroup.Enabled=!isS0&&st!="ended";
    object rawWake;var w=g.TryGetValue("wake",out rawWake)?rawWake as Dictionary<string,object>:null;
    wake.Enabled=!isS0&&st!="ended"&&w!=null&&Flag(w,"canWake");
    if(codex){reason.Text="깨우기: "+(w==null?"callback 미등록":Str(w,"state")+" "+Str(w,"reason"))+". 접수·차례 시작·목표 완료는 별도입니다. 종료는 기존 mux에서 합니다.";return;}
    reason.Text=isS0?"S0는 이 패널에서 닫거나 종료하지 않습니다.":Str(g,"sessionId")==""?"세션 ID가 없어 닫을 탭이 없습니다.":(st=="turn_active"||st=="stale")?"차례 진행 중에는 탭을 닫을 수 없습니다.":!Flag(g,"tabOpen")?"열린 탭이 없습니다.":"";
  }

  void Change(string action,bool end){
    var run=CurrentRun();var g=Selected();if(run==null||g==null)return;
    var input=new Dictionary<string,object>{{"run",Str(run,"opsDirectory")},{"name",Str(g,"name")}};
    if(end){input["reason"]="트레이에서 종료";input["closeTab"]=closeTab.Enabled;}
    Dictionary<string,object> preview=null;
    Background("미리보는 중…",()=>{
      EnsureSession();
      preview=Call("POST","supervise/preview",new Dictionary<string,object>{{"action",action},{"input",input}});
    },()=>{
      if(preview==null)return;
      string text=Str(preview,"impact")+"\n\n되돌리기: "+Str(preview,"rollback")+"\n\n이 확인은 한 번만 쓸 수 있고 "+Kst(Str(preview,"expiresAt"))+"까지 유효합니다.";
      if(MessageBox.Show(this,text,"변경 확인",MessageBoxButtons.OKCancel,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)!=DialogResult.OK){Notice("취소했습니다. 변경하지 않았습니다.");return;}
      string token=Str(preview,"confirmationToken");string message=null;
      Background("실행 중…",()=>{
        try{var result=Call("POST","supervise/confirm",new Dictionary<string,object>{{"confirmationToken",token}});object delivery;var d=result.TryGetValue("delivery",out delivery)?delivery as Dictionary<string,object>:null;message=d==null?"목록 변경 확인 · "+action:"전달 "+Str(d,"state")+" · 차례 "+Str(d,"turnId")+" · 목표 완료 별도 확인";}
        catch(SuperviseCallException e){message=e.Message;}
      },()=>{Reload(message);});
    });
  }

  void ShowLogs(){
    var run=CurrentRun();var g=Selected();if(run==null||g==null)return;
    bool isS0=groups.SelectedItems[0].Name=="S0";string name=Str(g,"name");
    Background("기록을 읽는 중…",()=>{
      var value=Call("GET","supervise/logs?run="+Uri.EscapeDataString(Str(run,"opsDirectory"))+"&lines=60",null);
      var text=new StringBuilder();
      if(isS0){
        text.AppendLine("# 깨우기 기록 (wake-log)");foreach(var line in Lines(value,"wakeLog"))text.AppendLine(line);
        text.AppendLine();text.AppendLine("# S0 기록 (SUPERVISOR-LOG)");foreach(var line in Lines(value,"supervisorLog"))text.AppendLine(line);
      }else foreach(var row in Items(value,"groups"))if(Str(row,"name")==name){text.AppendLine("# "+name+" PROGRESS · 수정 "+Kst(Str(row,"lastProgressAt")));foreach(var line in Lines(row,"lines"))text.AppendLine(line);}
      if(text.Length==0)text.Append("(기록 없음 · PROGRESS 파일이 등록되지 않았을 수 있습니다)");
      BeginInvoke((Action)(()=>{
        var form=new Form{Text="관제 기록 · "+(isS0?"S0":name),Size=new Size(860,560),StartPosition=FormStartPosition.CenterParent,BackColor=TrayTheme.Background,ForeColor=TrayTheme.Text,KeyPreview=true};
        var box=new TextBox{Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Both,WordWrap=false,Dock=DockStyle.Fill,Font=new Font("Cascadia Mono",9.5f),Text=text.ToString().Replace("\n","\r\n").Replace("\r\r\n","\r\n"),BackColor=TrayTheme.Surface,ForeColor=TrayTheme.Text};
        form.Controls.Add(box);form.KeyDown+=(s,e)=>{if(e.KeyCode==Keys.Escape)form.Close();};
        form.Show(this);box.SelectionStart=box.TextLength;box.ScrollToCaret();
      }));
    });
  }
  static IEnumerable<string> Lines(Dictionary<string,object> data,string key){
    object value;if(data==null||!data.TryGetValue(key,out value)||!(value is IEnumerable)||value is string)yield break;
    foreach(var item in (IEnumerable)value)yield return Convert.ToString(item);
  }
}

internal sealed class SuperviseCallException : Exception {
  internal readonly string Code;internal readonly Dictionary<string,object> Data2;
  internal SuperviseCallException(string message,string code,Dictionary<string,object> data):base(message){Code=code;Data2=data;}
}
