using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Existing tray host, no timer, daemon or model call. Phone and tray share the owner helper.
internal sealed class CodexConversationHost : UserControl {
  readonly TabControl tabs=new TabControl{Dock=DockStyle.Fill};
  readonly CodexContinuityPanel continuity;
  readonly AiccTerminalPickerPanel terminals;
  internal CodexConversationHost(string helper,Action<string> ownerTool){
    Dock=DockStyle.None;AutoScaleMode=AutoScaleMode.Dpi;
    continuity=new CodexContinuityPanel(helper){Dock=DockStyle.Fill,OwnerToolRequested=ownerTool};
    terminals=new AiccTerminalPickerPanel(Path.Combine(Path.GetDirectoryName(helper),"Invoke-AiccTerminalPicker.ps1")){Dock=DockStyle.Fill};
    var terminalTab=new TabPage("터미널 대화"){BackColor=TrayTheme.Background,ForeColor=TrayTheme.Text};terminalTab.Controls.Add(terminals);
    var desktopTab=new TabPage("Desktop · 자동재개"){BackColor=TrayTheme.Background,ForeColor=TrayTheme.Text};desktopTab.Controls.Add(continuity);
    tabs.TabPages.Add(terminalTab);tabs.TabPages.Add(desktopTab);Controls.Add(tabs);
    FontChanged+=(s,e)=>{tabs.Font=Font;continuity.Font=Font;terminals.Font=Font;};
  }
  internal void TickQueueFeedback(){if(tabs.SelectedIndex==1)continuity.TickQueueFeedback();}
  // Popup F5/F1 on page 6 act on the visible tab only; no other tab is read or started.
  internal void LoadRows(){if(tabs.SelectedIndex==1)continuity.LoadRows();else terminals.LoadRows(true);}
  internal void ShowHelp(){if(tabs.SelectedIndex==1)continuity.ShowHelp();else terminals.ShowHelp();}
}

internal sealed class AiccTerminalPickerPanel : UserControl {
  readonly string helper;
  readonly TextBox search=new TextBox{Dock=DockStyle.Fill};
  readonly ComboBox scope=new ComboBox{Dock=DockStyle.Fill,DropDownStyle=ComboBoxStyle.DropDownList};
  readonly ListView list=new ListView{Dock=DockStyle.Fill,View=View.Details,FullRowSelect=true,MultiSelect=false,HideSelection=false,ShowItemToolTips=true};
  readonly TextBox details=new TextBox{Dock=DockStyle.Fill,Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical,BorderStyle=BorderStyle.None};
  readonly Label notice=new Label{Dock=DockStyle.Fill,AutoSize=true};
  readonly Button open=new DarkTrayButton{Text="기존 터미널 연결",AutoSize=true},refresh=new DarkTrayButton{Text="새로 고침",AutoSize=true},shell=new DarkTrayButton{Text="새 PowerShell 열기",AutoSize=true};
  readonly ImageList rowHeight=new ImageList();
  readonly ToolTip tips=new ToolTip{ShowAlways=true,AutoPopDelay=12000,InitialDelay=350,ReshowDelay=150};
  readonly Dictionary<string,Dictionary<string,object>> rows=new Dictionary<string,Dictionary<string,object>>();
  static Dictionary<string,object> cached;
  bool busy,loaded,loadFailed;string observed="",failure="";
  internal AiccTerminalPickerPanel(string helperPath){
    helper=helperPath;AutoScaleMode=AutoScaleMode.Dpi;BackColor=TrayTheme.Background;ForeColor=TrayTheme.Text;
    foreach(var field in new TextBox[]{search,details}){field.BackColor=TrayTheme.Surface;field.ForeColor=TrayTheme.Text;}
    list.BackColor=TrayTheme.Background;list.ForeColor=TrayTheme.Text;
    scope.BackColor=TrayTheme.Surface;scope.ForeColor=TrayTheme.Text;scope.FlatStyle=FlatStyle.Flat;
    var layout=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(12),ColumnCount=1,RowCount=5};
    layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute,152));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));Controls.Add(layout);
    var top=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=3,AutoSize=true,Margin=new Padding(0,0,0,8)};
    top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,122));
    top.Controls.Add(new Label{Text="제목 검색",AutoSize=true,Padding=new Padding(0,5,8,0)},0,0);top.Controls.Add(search,1,0);top.Controls.Add(scope,2,0);layout.Controls.Add(top,0,0);
    search.AccessibleName="터미널 대화 제목 검색";search.AccessibleDescription="제목과 mux 이름 검색. 입력 중 모델 호출이나 원문 전송은 없습니다.";
    tips.SetToolTip(search,search.AccessibleDescription);
    scope.Items.AddRange(new object[]{"열린 대화","최근 대화"});scope.SelectedIndex=0;scope.AccessibleName="열린 대화 또는 최근 대화";
    scope.AccessibleDescription="열린 대화는 현재 mux입니다. 닫힌 Codex는 작성권 해제가 있어야 재개할 수 있습니다.";tips.SetToolTip(scope,scope.AccessibleDescription);
    list.AccessibleName="기존 터미널 대화 선택";list.AccessibleDescription="위아래 선택·Enter 연결 또는 재개. 열린 mux는 모델 작업 실행 증거가 아닙니다.";
    tips.SetToolTip(list,list.AccessibleDescription);
    list.Columns.Add("대화 제목 · 터미널 정보",440);list.BorderStyle=BorderStyle.FixedSingle;list.SmallImageList=rowHeight;list.OwnerDraw=true;
    list.DrawColumnHeader+=(s,e)=>{using(var b=new SolidBrush(TrayTheme.Surface))e.Graphics.FillRectangle(b,e.Bounds);Draw(e.Graphics,e.Header.Text,e.Bounds,TrayTheme.Text);};
    list.DrawItem+=(s,e)=>{};list.DrawSubItem+=(s,e)=>{
      using(var b=new SolidBrush(e.Item.Selected?TrayTheme.Blend(TrayTheme.Surface,TrayTheme.Accent,0.28f):TrayTheme.Background))e.Graphics.FillRectangle(b,e.Bounds);
      var row=e.Item.Tag as Dictionary<string,object>;var bounds=e.Bounds;bounds.Inflate(-6,0);bounds.Height/=2;
      Draw(e.Graphics,S(row,"title"),bounds,TrayTheme.Text);bounds.Y+=bounds.Height;Draw(e.Graphics,Secondary(row),bounds,TrayTheme.Muted);
      if(e.Item.Focused)ControlPaint.DrawFocusRectangle(e.Graphics,e.Bounds);
    };
    list.SizeChanged+=(s,e)=>list.Columns[0].Width=Math.Max(120,list.ClientSize.Width-SystemInformation.VerticalScrollBarWidth-4);
    list.SelectedIndexChanged+=(s,e)=>Selection();list.DoubleClick+=(s,e)=>OpenSelected();
    rowHeight.ImageSize=new Size(1,Math.Min(128,Math.Max(52,Font.Height*2+14)));
    FontChanged+=(s,e)=>rowHeight.ImageSize=new Size(1,Math.Min(128,Math.Max(52,Font.Height*2+14)));
    layout.Controls.Add(list,0,1);details.AccessibleName="선택한 대화 전체 정보와 열기 조건";details.AccessibleDescription="첫 줄에 동작과 비활성 사유, 그다음 대화 ID와 작업 폴더를 표시합니다.";details.WordWrap=true;layout.Controls.Add(details,0,2);
    var actions=new FlowLayoutPanel{Dock=DockStyle.Fill,AutoSize=true,WrapContents=true,Margin=Padding.Empty};layout.Controls.Add(actions,0,3);
    Add(actions,open,"열린 mux는 기존 창에 연결만 합니다. 닫힌 Codex는 정확한 대화와 작성권 해제·불명0 근거가 필요합니다.",OpenSelected);
    Add(actions,refresh,"목록을 한 번 새로 읽습니다. 새 대화나 모델 요청을 만들지 않습니다.",()=>LoadRows(true));
    Add(actions,shell,"새 PowerShell 명령 창을 엽니다. 이전 명령·Codex·모델은 실행하지 않습니다.",()=>Execute("PowerShell",null));
    var help=new DarkTrayButton{Text="사용법 · F1",AutoSize=true};Add(actions,help,"키보드 사용법과 열기 조건을 표시합니다.",ShowHelp);
    notice.Text="목록을 아직 확인하지 않았습니다. F5로 새로 고칠 수 있습니다.";notice.AccessibleName="터미널 목록 상태";
    notice.AccessibleDescription="조회 중, 빈 목록, 오류와 요청 접수 상태";notice.Padding=new Padding(0,6,0,0);layout.Controls.Add(notice,0,4);
    search.TextChanged+=(s,e)=>FilterRows();scope.SelectedIndexChanged+=(s,e)=>FilterRows();
    search.KeyDown+=(s,e)=>{if(e.KeyCode==Keys.Down&&list.Items.Count>0){list.Focus();list.Items[0].Selected=true;e.SuppressKeyPress=true;}};
    VisibleChanged+=(s,e)=>{if(Visible)LoadRows(false);};Selection();
  }
  static string S(Dictionary<string,object> row,string key){object value;return row!=null&&row.TryGetValue(key,out value)&&value!=null?Convert.ToString(value):"";}
  static bool B(Dictionary<string,object> row,string key){return S(row,key).Equals("True",StringComparison.OrdinalIgnoreCase);}
  static string Secondary(Dictionary<string,object> row){
    DateTimeOffset time;string last=DateTimeOffset.TryParse(S(row,"lastOpened"),out time)?time.ToLocalTime().ToString("MM-dd HH:mm"):"미확인";
    return S(row,"session")+" · "+S(row,"kind")+" · "+S(row,"model")+" / "+S(row,"effort")+" · 마지막 열기 "+last;
  }
  void Draw(Graphics g,string text,Rectangle bounds,Color color){TextRenderer.DrawText(g,text,Font,bounds,color,TextFormatFlags.Left|TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix|TextFormatFlags.PreserveGraphicsClipping|TextFormatFlags.PreserveGraphicsTranslateTransform);}
  void Add(FlowLayoutPanel area,Button button,string help,Action action){button.Padding=new Padding(8,4,8,4);button.Margin=new Padding(0,4,6,4);button.MinimumSize=new Size(72,32);button.AccessibleName=button.Text;button.AccessibleDescription=help;tips.SetToolTip(button,help);button.Click+=(s,e)=>action();area.Controls.Add(button);}
  Dictionary<string,object> Selected(){return list.SelectedItems.Count==1?list.SelectedItems[0].Tag as Dictionary<string,object>:null;}
  void Selection(){
    var row=Selected();bool opened=row!=null&&B(row,"opened");
    open.Text=opened?"기존 터미널 연결":"저장 대화 이어 열기";open.AccessibleName=open.Text;
    string reason=busy?"목록 확인 또는 창 열기 요청 중입니다. 완료 후 선택하세요.":
      loadFailed?"조회 또는 열기 결과를 확인해야 합니다. F5로 목록을 다시 읽으세요. "+failure:
      !loaded?"목록을 아직 확인하지 않았습니다. F5로 새로 고치세요.":
      rows.Count==0?"저장된 터미널이 없습니다. 새 PowerShell은 별도 버튼을 사용하세요.":
      list.Items.Count==0?"현재 검색 또는 열린/최근 보기와 맞는 항목이 없습니다.":
      row==null?"항목 하나를 선택하세요. ↑↓와 Enter를 사용할 수 있습니다.":
      !B(row,"canOpen")?S(row,"disabledReason"):"";
    open.Enabled=!busy&&!loadFailed&&loaded&&row!=null&&B(row,"canOpen");
    refresh.Enabled=!busy;shell.Enabled=!busy;
    string action=opened?"기존 mux 창 연결만 요청합니다. 모델 작업은 실행하지 않습니다.":
      "저장된 Codex 대화를 정확한 ID·기존 경로·작성권 해제·불명0 근거가 맞을 때만 재개합니다.";
    string message=reason!=""?"안내: "+reason:"동작: "+action;
    details.Text=message+(row==null?"":Environment.NewLine+S(row,"title")+Environment.NewLine+
      Secondary(row)+Environment.NewLine+
      (opened?"터미널 열림 · 실제 모델 작업 미확인":"저장 기록 · 닫힘")+Environment.NewLine+
      "작업 폴더: "+S(row,"cwd")+Environment.NewLine+
      "대화 ID: "+(S(row,"threadId")==""?"미확인":S(row,"threadId")));
    open.AccessibleDescription=open.Text+". "+message+" "+action;tips.SetToolTip(open,open.AccessibleDescription);
  }
  void Apply(Dictionary<string,object> snapshot){
    object raw;var items=snapshot.TryGetValue("items",out raw)?raw as IEnumerable:null;rows.Clear();
    if(items!=null)foreach(object value in items){var row=value as Dictionary<string,object>;if(row!=null&&S(row,"id")!="")rows[S(row,"id")]=row;}
    observed=S(snapshot,"observedAt");FilterRows();
  }
  void FilterRows(){
    string selected=S(Selected(),"id"),selectedBinding=S(Selected(),"binding"),query=search.Text.Trim();list.BeginUpdate();list.Items.Clear();
    foreach(var row in rows.Values){
      if(scope.SelectedIndex==0&&!B(row,"opened"))continue;
      if(query!=""&&(S(row,"title")+" "+S(row,"session")).IndexOf(query,StringComparison.OrdinalIgnoreCase)<0)continue;
      var item=new ListViewItem(S(row,"title")){Tag=row,ToolTipText=S(row,"title")+Environment.NewLine+Secondary(row)};list.Items.Add(item);if(S(row,"id")==selected&&S(row,"binding")==selectedBinding)item.Selected=true;
    }
    list.EndUpdate();Selection();
  }
  static string Quote(string value){if(value==null||value.IndexOfAny(new[]{'"','\r','\n','\0'})>=0)throw new InvalidOperationException("잘못된 실행 인수");return "\""+value+"\"";}
  Dictionary<string,object> Call(string action,Dictionary<string,object> row,bool force){
    if(!File.Exists(helper))throw new InvalidOperationException("공유 터미널 helper가 설치되지 않았습니다.");
    string ps=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe");
    string args="-NoLogo -NoProfile -NonInteractive -File "+Quote(helper)+" -Action "+action+(force?" -Refresh":"");
    if(row!=null)args+=" -RecordId "+Quote(S(row,"id"))+" -Binding "+Quote(S(row,"binding"));
    var info=new ProcessStartInfo(ps,args){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=new UTF8Encoding(false,true),StandardErrorEncoding=new UTF8Encoding(false,true)};
    using(var child=Process.Start(info)){
      var output=child.StandardOutput.ReadToEndAsync();var errors=child.StandardError.ReadToEndAsync();
      if(!child.WaitForExit(45000))throw new InvalidOperationException("응답 대기 시간 초과 · 원 결과를 확인하기 전에는 재시도하지 않습니다.");
      if(child.ExitCode!=0)throw new InvalidOperationException(errors.Result.Length>1400?"공유 helper가 보류했습니다. 원 기록을 확인하세요.":errors.Result);
      return new JavaScriptSerializer{MaxJsonLength=2*1024*1024}.Deserialize<Dictionary<string,object>>(output.Result);
    }
  }
  internal void LoadRows(bool force){
    if(busy)return;if(cached!=null&&!loaded)Apply(cached);
    busy=true;Selection();notice.Text="저장된 목록을 보존하며 현재 터미널을 한 번 확인합니다…";
    ThreadPool.QueueUserWorkItem(_=>{try{
      var snapshot=Call("Snapshot",null,true);if(IsDisposed)return;
      BeginInvoke((Action)(()=>{cached=snapshot;Apply(snapshot);busy=false;loaded=true;loadFailed=false;failure="";
        Selection();notice.Text=rows.Count==0?"저장된 항목 없음 · 새 PowerShell은 별도 버튼":rows.Count+"개 · "+observed+" · 열린 mux와 모델 작업은 별개";}));
    }catch(Exception ex){PostFailure(ex.Message);}});
  }
  void OpenSelected(){var row=Selected();if(!busy&&open.Enabled&&row!=null)Execute("Open",new Dictionary<string,object>(row));}
  void Execute(string action,Dictionary<string,object> row){
    if(busy)return;busy=true;Selection();
    notice.Text=action=="Open"?"선택 항목의 현재 결속을 재확인합니다…":"새 PowerShell 창 열기 요청 중…";
    ThreadPool.QueueUserWorkItem(_=>{try{var result=Call(action,row,false);if(IsDisposed)return;
      BeginInvoke((Action)(()=>{busy=false;Selection();
        notice.Text=(action=="PowerShell"?"새 PowerShell 창 요청 · ":"기존 항목 창 요청 · ")+S(result,"state")+" · 모델 작업 완료 증거 아님";}));
    }catch(Exception ex){PostFailure(ex.Message);}});
  }
  void PostFailure(string text){if(IsDisposed)return;try{BeginInvoke((Action)(()=>{busy=false;loadFailed=true;failure=text;Selection();notice.Text="조회/열기 보류 · F5 확인 전에는 기존 항목을 열지 않습니다. 자동 재시도 없음."; }));}catch(InvalidOperationException){}}
  internal void ShowHelp(){MessageBox.Show(this,"제목 검색 → 열린/최근 목록 → 선택\n↑↓ 이동 · Enter/두 번 클릭 연결 또는 재개 · F5 새로 고침 · F1 사용법 · Esc 닫기\n\n[기존 터미널 연결]은 열린 mux에 연결만 합니다. [저장 대화 이어 열기]는 닫힌 Codex의 정확한 ID·기존 경로·정상 종료·작성권 해제·active0/UNKNOWN0이 필요합니다. 부족하면 비활성입니다.\n\n제목과 모델은 저장된 기록이며 현재 모델이 작업 중이라는 뜻이 아닙니다. 오류 뒤에는 F5로 재확인합니다. [새 PowerShell 열기]는 이전 명령이나 모델을 실행하지 않습니다.","터미널 대화 선택",MessageBoxButtons.OK,MessageBoxIcon.Information);}
  protected override bool ProcessCmdKey(ref Message msg,Keys key){if(key==Keys.F1){ShowHelp();return true;}if(key==Keys.F5){LoadRows(true);return true;}if(key==Keys.Enter&&(list.ContainsFocus||search.ContainsFocus)){OpenSelected();return true;}return base.ProcessCmdKey(ref msg,key);}
  protected override void Dispose(bool disposing){if(disposing){tips.Dispose();rowHeight.Dispose();}base.Dispose(disposing);}
}
