using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Uses the same local owner helper as the tray. No credentials enter the UI.
internal sealed class AiccOperationsDialog : Form {
 readonly bool rdc; readonly Font ownedFont=new Font("Segoe UI Variable Text",10); Font titleFont;
 readonly string helper,shell;
 readonly TextBox details=new TextBox{Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical,Dock=DockStyle.Fill,TabStop=true};
 readonly Label hint=new Label{AutoSize=true,MaximumSize=new Size(660,0),Padding=new Padding(0,8,0,8)};
 readonly FlowLayoutPanel actions=new FlowLayoutPanel{AutoSize=true,Dock=DockStyle.Fill,WrapContents=true};
 readonly ComboBox profiles=new ComboBox{DropDownStyle=ComboBoxStyle.DropDown,Width=190,AccessibleName="RDC 저장 계정 이름"};
 readonly Button refresh=new DarkTrayButton(),repair=new DarkTrayButton(),save=new DarkTrayButton(),pick=new DarkTrayButton(),pair=new DarkTrayButton();
 readonly ToolTip help=new ToolTip{ShowAlways=true,AutoPopDelay=20000};
 readonly BackgroundWorker worker=new BackgroundWorker();
 readonly System.Windows.Forms.Timer statusTimer=new System.Windows.Forms.Timer{Interval=15000};
 Dictionary<string,object> data;
 bool busy,closeWhenIdle; string runningAction=""; bool statusOnly;
 static string Value(Dictionary<string,object> d,string k){object v;return d!=null&&d.TryGetValue(k,out v)&&v!=null?Convert.ToString(v):"";}
 static bool Flag(Dictionary<string,object> d,string k){object v;return d!=null&&d.TryGetValue(k,out v)&&v is bool&&(bool)v;}
 static string Quote(string s){if(s==null||s.IndexOfAny(new[]{'"','\r','\n'})>=0)throw new InvalidOperationException("Invalid owner argument");return "\""+s+"\"";}
 internal AiccOperationsDialog(bool remote,string ownerHelper,string powershell){
  rdc=remote;helper=ownerHelper;shell=powershell;
  Text=rdc?"RDC 계정 전환":"AICC 문제 해결";StartPosition=FormStartPosition.CenterParent;MinimumSize=new Size(540,440);Size=new Size(720,580);AutoScaleMode=AutoScaleMode.Dpi;
  Font=ownedFont;BackColor=TrayTheme.Background;ForeColor=TrayTheme.Text;
  details.BackColor=TrayTheme.Surface;details.ForeColor=TrayTheme.Text;details.BorderStyle=BorderStyle.FixedSingle;details.AccessibleName="현재 상태와 복구 결과";
  var layout=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,RowCount=4,Padding=new Padding(16)};
  layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));Controls.Add(layout);
  titleFont=new Font(Font,FontStyle.Bold);var title=new Label{Text=rdc?"현재 연결 확인 → 로그인 저장 → 저장 계정 전환":"연결 상태 확인 → 복구 준비 → 준비된 복구 적용",AutoSize=true,Font=titleFont,Padding=new Padding(0,0,0,12)};
  layout.Controls.Add(title,0,0);layout.Controls.Add(details,0,1);layout.Controls.Add(hint,0,2);layout.Controls.Add(actions,0,3);
  Configure(refresh,"상태 조회","현재 연결과 실행 작업을 새로 읽습니다. 설정을 바꾸지 않습니다.",()=>Run(rdc?"RdcStatus":"Status"));actions.Controls.Add(refresh);
  if(rdc){
   actions.Controls.Add(profiles);profiles.Text="current";profiles.BackColor=TrayTheme.Surface;profiles.ForeColor=TrayTheme.Text;
   Configure(save,"현재 로그인 저장","이름을 입력하고 누르면 현재 RDC 로그인 정보를 이 Windows 사용자만 읽을 수 있게 암호화해 저장합니다.",()=>Run("RdcSave",profiles.Text));
   Configure(pick,"저장 계정으로 전환","저장 이름을 선택합니다. 등록된 지피티 연결과 로컬 작업 프로세스를 보존하며 중계만 전환합니다.",()=>Run("RdcSwitch",profiles.Text));
   Configure(pair,"다른 계정 연결","현재 로그인을 보존한 뒤 공식 인증 화면을 엽니다. 해당 화면에서 연결할 계정을 선택하세요.",()=>Run("RdcPair"));
   actions.Controls.Add(save);actions.Controls.Add(pick);actions.Controls.Add(pair);
   var automatic=new DarkTrayButton();Configure(automatic,"자동 순환 시작","잔여 사용량 신호를 받아 다음 계정으로 순환합니다. 최초 지피티 연결과 실제 도구 link_id 등록이 필요합니다.",()=>Run("RdcAuto"));actions.Controls.Add(automatic);
   var next=new DarkTrayButton();Configure(next,"다음 계정","단일 전환 담당에게 다음 계정 전환을 요청합니다. 병렬 요청은 같은 진행 상태를 받습니다.",()=>Run("RdcNext"));actions.Controls.Add(next);
   var stop=new DarkTrayButton();Configure(stop,"자동 순환 중지","진행 중인 전환 뒤 감시만 중지합니다. RDC 프로세스와 실행 세션은 유지합니다.",()=>Run("RdcAutoStop"));actions.Controls.Add(stop);
   statusTimer.Tick+=(sender,e)=>{if(Visible&&!busy)Run("RdcStatus");};
  }else{
   var copy=new DarkTrayButton();Configure(copy,"진단 복사","현재 연결과 미확인 호출을 복사합니다. 코덱스에 붙여 넣으면 같은 요청을 재전송하지 않고 복구 준비를 이어갈 수 있습니다.",()=>{Clipboard.SetText("AICC 문제 해결을 이어가 주세요. 미확인 원 요청은 재전송하지 말고, 현재 상태를 다시 확인한 뒤 복구 계획과 독립 복구 준비를 마련해 주세요.\r\n\r\n"+details.Text+"\r\n"+hint.Text);hint.Text="진단을 복사했습니다. 코덱스 대화에 붙여 넣으세요.";});actions.Controls.Add(copy);
   Configure(repair,"준비된 복구 적용","원 검색을 재전송하지 않습니다. 독립 복구 준비와 실행 작업 없음이 확인된 단회 계획만 적용합니다.",()=>Run("Repair"));actions.Controls.Add(repair);
  }
  var guide=new DarkTrayButton();Configure(guide,"사용법 · F1","목적과 사용 순서, 잠긴 이유와 해결 방법을 봅니다.",Guide);actions.Controls.Add(guide);
  worker.DoWork+=(sender,e)=>{
   var command=(string[])e.Argument;
   var args="-NoLogo -NoProfile -NonInteractive -File "+Quote(helper)+" -Action "+command[0];
   if(command.Length>1&&command[1]!=null)args+=" -Profile "+Quote(command[1]);
   if(command[0]=="Repair")args+=" -OperationDirectory "+Quote(Value(data,"operationDirectory"));
   using(var p=Process.Start(new ProcessStartInfo(shell,args){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=new UTF8Encoding(false),StandardErrorEncoding=new UTF8Encoding(false)})){
    var output=p.StandardOutput.ReadToEndAsync();var error=p.StandardError.ReadToEndAsync();
    // Do not kill a repair whose result could already have been committed.
    if(command[0]=="RdcStatus"||command[0]=="Status"){if(!p.WaitForExit(30000)){try{p.Kill();}catch{}throw new TimeoutException("상태 조회 시간이 초과됐습니다. 연결과 원 요청은 그대로 유지됩니다.");}}else p.WaitForExit();
    if(p.ExitCode!=0)throw new InvalidOperationException("작업을 완료하지 못했습니다. "+System.Text.RegularExpressions.Regex.Replace(error.Result,@"\x1b\[[0-9;]*m", ""));
    e.Result=new JavaScriptSerializer{MaxJsonLength=1048576}.Deserialize<Dictionary<string,object>>(output.Result);
   }
  };
  worker.RunWorkerCompleted+=WorkerCompleted;
  KeyPreview=true;KeyDown+=(sender,e)=>{if(e.KeyCode==Keys.F1){Guide();e.Handled=true;}else if(e.KeyCode==Keys.F5){Run(rdc?"RdcStatus":"Status");e.Handled=true;}};
  FormClosing+=(sender,e)=>{if(busy&&statusOnly){e.Cancel=true;closeWhenIdle=true;Hide();statusTimer.Stop();return;}if(busy&&!statusOnly){e.Cancel=true;hint.Text="변경 요청 처리 중입니다. 원 결과를 보존하고 완료 후 닫습니다.";}};
  Shown+=(sender,e)=>{Run(rdc?"RdcStatus":"Status");if(rdc)statusTimer.Start();}; VisibleChanged+=(sender,e)=>{if(!Visible)statusTimer.Stop();};SetButtons();
 }
 void WorkerCompleted(object sender,RunWorkerCompletedEventArgs e){
   busy=false;if(closeWhenIdle){BeginInvoke((Action)(()=>{Close();Dispose();}));return;}if(IsDisposed||Disposing){worker.Dispose();return;}
   if(e.Error!=null){hint.Text=statusOnly?"상태 조회 실패 · F5로 다시 조회할 수 있습니다.":"변경 완료 여부를 확인하세요. 같은 요청을 반복하지 마세요.";details.Text=e.Error.Message;SetButtons();return;}
   var result=e.Result as Dictionary<string,object>;
   if(result!=null&&result.ContainsKey("message"))hint.Text=Value(result,"message");
   if(rdc&&result!=null&&result.ContainsKey("phase")&&!result.ContainsKey("profiles")){details.Text=new JavaScriptSerializer().Serialize(result);Run("RdcStatus");return;}
   if(result!=null&&(result.ContainsKey("phase")||result.ContainsKey("profiles"))){data=result;Render();}
   else{details.Text=new JavaScriptSerializer().Serialize(result);Run(rdc?"RdcStatus":"Status");}
   SetButtons();
 }
 void Configure(Button b,string label,string description,Action action){b.Text=label;b.AutoSize=true;b.MinimumSize=new Size(90,34);b.Padding=new Padding(8,4,8,4);b.Margin=new Padding(0,4,8,4);b.BackColor=TrayTheme.Surface;b.ForeColor=TrayTheme.Text;b.AccessibleDescription=description;help.SetToolTip(b,description);b.Enter+=(s,e)=>{if(!IsDisposed&&!Disposing)hint.Text=description;};b.Click+=(s,e)=>action();}
 void Guide(){MessageBox.Show(this,rdc?"RDC 자동 순환은 세 저장 계정과 지피티의 계정별 link_id를 사용합니다.\n\n자동 순환 시작: 사용량 신호를 받아 순서대로 전환합니다.\n다음 계정: 지금 다음 계정 전환을 요청합니다.\n저장 계정으로 전환: 선택한 등록 계정으로 전환합니다.\n자동 순환 중지: 감시만 중지하고 실행 세션은 유지합니다.\n\n지피티는 상태의 link_id로 신원·기기·읽기 성공을 확인한 뒤 완료를 알립니다. 결과 불명·실행 중·미등록 연결은 보류하며 상태와 operation ID를 유지합니다. 기존 로그인 저장·공식 새 계정 연결도 사용할 수 있습니다.":"AICC 상태 조회로 현재 게이트웨이와 미확인 호출을 읽습니다.\n\n진단 복사는 원 요청을 재전송하지 않고 복구를 이어가기 위한 자료입니다.\n준비된 복구 적용은 정확한 대상·백업·새 독립 READY가 있어야 열립니다. 실행 중 작업이나 쓰기 결과 불명은 원 담당이 먼저 조정합니다.",Text,MessageBoxButtons.OK,MessageBoxIcon.Information);} void Run(string action,string profile=null){if(busy)return;if(profile!=null&&!System.Text.RegularExpressions.Regex.IsMatch(profile,@"\A[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}\z")){hint.Text="저장 이름은 영문·숫자·밑줄·하이픈으로 1~40자 입력하세요.";return;}busy=true;runningAction=action;statusOnly=action=="RdcStatus"||action=="Status";if(!statusOnly)hint.Text="변경 요청 처리 중 · 같은 요청은 한 번만 전달합니다…";else if(data==null)hint.Text="연결 상태를 조회합니다. 계정 전환은 실행하지 않습니다.";SetButtons();worker.RunWorkerAsync(new[]{action,profile});}
 void SetButtons(){foreach(Control c in actions.Controls)if(c is Button)c.Enabled=!busy;refresh.Enabled=!busy;save.Enabled=!busy;profiles.Enabled=!busy;pick.Enabled=pair.Enabled=!busy&&Flag(data,"managed")&&Value(data,"state")=="CONNECTED"&&Value(data,"active")=="0"&&Value(data,"unknown")=="0";repair.Enabled=!busy&&Flag(data,"repairable")&&Flag(data,"prepared");if(!busy&&data==null)hint.Text="상태 조회를 먼저 누르세요.";}
 IEnumerable<string> ProfileNames(){foreach(var item in profiles.Items)yield return Convert.ToString(item);}
 void Render(){
  if(rdc){var selected=profiles.Text;object value;var items=data.TryGetValue("profiles",out value)?value as System.Collections.IEnumerable:null;var names=new List<string>();if(items!=null)foreach(var item in items)names.Add(Convert.ToString(item));if(String.Join("|",names)!=String.Join("|",ProfileNames())){profiles.Items.Clear();foreach(string name in names)profiles.Items.Add(name);}var current=Value(data,"currentProfile");profiles.Text=(selected=="current"||selected.Length==0)&&current.Length>0?current:selected;details.Text="연결 상태: "+Value(data,"state")+"\r\n현재 저장 이름: "+(current.Length>0?current:"저장 전")+"\r\n실행 중: "+Value(data,"active")+"\r\n결과 미확인: "+Value(data,"unknown")+"\r\n\r\n저장 이름은 사용자가 붙인 로컬 이름입니다.";}
  else {
   var text=new StringBuilder("AICC 상태: "+Value(data,"phase")+"\r\n게이트웨이 PID: "+Value(data,"gatewayPid")+"\r\n");
   object raw;var providers=data.TryGetValue("providers",out raw)?raw as Dictionary<string,object>:null;
   if(providers!=null)foreach(var provider in providers){var state=provider.Value as Dictionary<string,object>;text.Append("\r\n").Append(provider.Key=="workspace"?"Workspace":"Codex 연결").Append(" · 실행 ").Append(Value(state,"active")).Append(" / 결과 미확인 ").Append(Value(state,"unknown")).Append(" / 재연결 ").Append(Value(state,"reconnecting"));}
   text.Append("\r\n\r\n미확인 호출: ");var calls=data.TryGetValue("unknown",out raw)?raw as System.Collections.IEnumerable:null;bool any=false;
   if(calls!=null)foreach(var call in calls){any=true;var item=call as Dictionary<string,object>;text.Append("\r\n").Append(Value(item,"tool")).Append(" · ").Append(Value(item,"callId"));}
   if(!any)text.Append("없음");else text.Append("\r\n원 결과를 보존하며 재전송하지 않습니다.");details.Text=text.ToString();
  }
  if(rdc){object rawRotation;var rotation=data.TryGetValue("rotation",out rawRotation)?rawRotation as Dictionary<string,object>:null;if(rotation!=null)details.AppendText("\r\n\r\n전환: "+Value(rotation,"phase")+"\r\n작업 ID: "+Value(rotation,"operationId")+"\r\n대상: "+Value(rotation,"target")+"\r\n"+Value(rotation,"message"));}hint.Text=Value(data,"message")+" · 자동 상태 조회 15초 (계정 변경 없음)";SetButtons();
 }
 protected override void Dispose(bool disposing){if(disposing&&busy&&statusOnly){closeWhenIdle=true;Hide();statusTimer.Stop();return;}if(disposing){statusTimer.Stop();statusTimer.Dispose();help.Dispose();worker.RunWorkerCompleted-=WorkerCompleted;if(busy)worker.RunWorkerCompleted+=(s,e)=>worker.Dispose();else worker.Dispose();}base.Dispose(disposing);if(disposing){if(titleFont!=null)titleFont.Dispose();ownedFont.Dispose();}}
}
