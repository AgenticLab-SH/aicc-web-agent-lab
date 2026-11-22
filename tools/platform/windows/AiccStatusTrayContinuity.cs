using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class CodexContinuityPanel : UserControl {
  internal Action<string> OwnerToolRequested;
  readonly string helper;
  readonly ListView recent=new ListView();
  readonly Label notice=new Label(),actionHint=new Label();
  readonly TextBox selectionInfo=new TextBox();
  readonly TextBox message=new TextBox();readonly Button send=new DarkTrayButton();
  readonly Button find=new DarkTrayButton();readonly Label composeTarget=new Label();
  readonly Dictionary<string,string> drafts=new Dictionary<string,string>();
  readonly Dictionary<string,Dictionary<string,object>> resolved=new Dictionary<string,Dictionary<string,object>>();
  string draftTarget="";bool swappingDraft,rebuilding;
  bool queueSupported,queuePending,refreshRequired;DateTime nextQueueRefresh=DateTime.MinValue;
  readonly ToolTip tips=new ToolTip{InitialDelay=400,ReshowDelay=100,AutoPopDelay=15000,ShowAlways=true};
  readonly Dictionary<Control,string> help=new Dictionary<Control,string>();
  readonly Button refresh=new DarkTrayButton(),register=new DarkTrayButton(),enable=new DarkTrayButton(),disable=new DarkTrayButton(),resume=new DarkTrayButton(),complete=new DarkTrayButton(),web=new DarkTrayButton(),phone=new DarkTrayButton(),guide=new DarkTrayButton();
  readonly Dictionary<string,Dictionary<string,object>> rows=new Dictionary<string,Dictionary<string,object>>();
  bool busy,protocolOk; readonly TextBox search=new TextBox();
  readonly ComboBox viewFilter=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,FlatStyle=FlatStyle.Flat};
  readonly Label overview=new Label{AutoSize=true}; readonly ImageList rowSize=new ImageList(); string filter="";
  internal CodexContinuityPanel(string helperPath){
    helper=helperPath;AutoScaleMode=AutoScaleMode.Dpi;BackColor=TrayTheme.Background;ForeColor=TrayTheme.Text;DoubleBuffered=true;
    tips.BackColor=SystemColors.Info;tips.ForeColor=SystemColors.InfoText;
    var layout=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(12),ColumnCount=1,RowCount=7,BackColor=TrayTheme.Background};
    layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
    layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute,72));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));Controls.Add(layout);
    var top=new TableLayoutPanel{Dock=DockStyle.Fill,AutoSize=true,ColumnCount=3,Margin=Padding.Empty,Padding=new Padding(0,0,0,8)};
    top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));layout.Controls.Add(top,0,0);
    viewFilter.Items.AddRange(new object[]{"모든 대화","재개 등록됨","자동재개 켜짐","확인 필요"});viewFilter.SelectedIndex=0;viewFilter.AccessibleName="대화와 재개 현황 필터";viewFilter.BackColor=TrayTheme.Surface;viewFilter.ForeColor=TrayTheme.Text;viewFilter.Width=132;viewFilter.SelectedIndexChanged+=(s,e)=>FilterRows();top.Controls.Add(viewFilter,0,0);
    overview.Text="대화 선택 · 전송 · 자동재개를 한곳에서 관리합니다.";overview.ForeColor=TrayTheme.Muted;overview.Margin=new Padding(0,6,0,4);top.Controls.Add(overview,0,1);top.SetColumnSpan(overview,3);
    search.Dock=DockStyle.Fill;search.BackColor=TrayTheme.Surface;search.ForeColor=TrayTheme.Text;search.BorderStyle=BorderStyle.FixedSingle;search.AccessibleName="대화 제목 또는 ID 검색";
    search.AccessibleDescription="제목, 전체 ID, codex://threads 링크로 검색합니다.";tips.SetToolTip(search,search.AccessibleDescription);top.Controls.Add(search,1,0);
    search.TextChanged+=(s,e)=>{filter=search.Text.Trim().Replace("codex://threads/","");FilterRows();};
    search.KeyDown+=(s,e)=>{if(e.KeyCode==Keys.Enter&&find.Enabled){FindThread();e.Handled=true;e.SuppressKeyPress=true;}};
    var findArea=new FlowLayoutPanel{Dock=DockStyle.Fill,AutoSize=true,WrapContents=false,Margin=Padding.Empty};top.Controls.Add(findArea,2,0);
    AddButton(findArea,find,"ID 찾기",FindThread,"전체 대화 ID나 codex://threads 링크를 입력하고 누릅니다. 최근 목록에 없는 오래된 활성 대화도 찾습니다. 보관함을 복원하거나 메시지를 보내지 않습니다.");
    findArea.MouseMove+=(s,e)=>{actionHint.Text=find.AccessibleDescription;tips.SetToolTip(findArea,find.AccessibleDescription);};
    recent.Dock=DockStyle.Fill;recent.View=View.Details;recent.FullRowSelect=true;recent.MultiSelect=true;recent.ShowItemToolTips=true;recent.HideSelection=false;recent.BackColor=TrayTheme.Surface;recent.ForeColor=TrayTheme.Text;recent.AccessibleName="자동재개할 대화 선택";recent.AccessibleDescription="위아래 키로 대화를 선택하고 아래 선택 정보에서 상태와 가능한 행동을 확인합니다. 여러 대화는 Ctrl 또는 Shift로 선택합니다.";recent.Columns.Add("제목 · ID",260);recent.Columns.Add("자동재개",80);recent.Columns.Add("현재 상태",180);layout.Controls.Add(recent,0,1);
    recent.BorderStyle=BorderStyle.None;recent.OwnerDraw=true;recent.SmallImageList=rowSize;
    recent.DoubleClick+=(s,e)=>OpenSelectedThread();
    FontChanged+=(s,e)=>rowSize.ImageSize=new Size(1,Math.Min(128,Math.Max(42,Font.Height*2+8)));
    rowSize.ImageSize=new Size(1,Math.Max(42,Font.Height*2+8));
    recent.DrawColumnHeader+=(s,e)=>{using(var brush=new SolidBrush(TrayTheme.Surface))e.Graphics.FillRectangle(brush,e.Bounds);TextRenderer.DrawText(e.Graphics,e.Header.Text,Font,e.Bounds,TrayTheme.Muted,TextFormatFlags.VerticalCenter|TextFormatFlags.Left|TextFormatFlags.EndEllipsis|TextFormatFlags.PreserveGraphicsClipping|TextFormatFlags.PreserveGraphicsTranslateTransform);};
    recent.DrawItem+=(s,e)=>{};
    recent.DrawSubItem+=(s,e)=>{
      Color background=e.Item.Selected?TrayTheme.Blend(TrayTheme.Surface,TrayTheme.Accent,0.28f):TrayTheme.Background;
      using(var brush=new SolidBrush(background))e.Graphics.FillRectangle(brush,e.Bounds);
      var bounds=e.Bounds;bounds.Inflate(-6,0);
      if(e.ColumnIndex==0){
        var text=bounds;text.Height=bounds.Height/2;TextRenderer.DrawText(e.Graphics,e.SubItem.Text,Font,text,TrayTheme.Text,TextFormatFlags.VerticalCenter|TextFormatFlags.Left|TextFormatFlags.EndEllipsis|TextFormatFlags.PreserveGraphicsClipping|TextFormatFlags.PreserveGraphicsTranslateTransform);
        text.Y+=text.Height;string id=Convert.ToString(e.Item.Tag);TextRenderer.DrawText(e.Graphics,id.Length>8?id.Substring(0,8):id,Font,text,TrayTheme.Muted,TextFormatFlags.VerticalCenter|TextFormatFlags.Left|TextFormatFlags.EndEllipsis|TextFormatFlags.PreserveGraphicsClipping|TextFormatFlags.PreserveGraphicsTranslateTransform);
      }else TextRenderer.DrawText(e.Graphics,e.SubItem.Text,Font,bounds,TrayTheme.Text,TextFormatFlags.VerticalCenter|TextFormatFlags.Left|TextFormatFlags.EndEllipsis|TextFormatFlags.PreserveGraphicsClipping|TextFormatFlags.PreserveGraphicsTranslateTransform);
      if(e.Item.Focused&&e.ColumnIndex==0)ControlPaint.DrawFocusRectangle(e.Graphics,e.Bounds);
    };
    recent.SizeChanged+=(s,e)=>{int width=Math.Max(200,recent.ClientSize.Width-SystemInformation.VerticalScrollBarWidth-4);recent.Columns[1].Width=80;recent.Columns[2].Width=Math.Min(180,width/3);recent.Columns[0].Width=Math.Max(80,width-80-recent.Columns[2].Width);};
    selectionInfo.Multiline=true;selectionInfo.ReadOnly=true;selectionInfo.BorderStyle=BorderStyle.None;selectionInfo.Dock=DockStyle.Fill;selectionInfo.ScrollBars=ScrollBars.Vertical;selectionInfo.BackColor=TrayTheme.Surface;selectionInfo.ForeColor=TrayTheme.Text;selectionInfo.AccessibleName="선택한 대화의 상태와 사용 순서";selectionInfo.Text="대화를 선택하면 등록 여부, 실행 경로와 다음 행동을 안내합니다.";selectionInfo.Margin=new Padding(0,8,0,8);layout.Controls.Add(selectionInfo,0,2);
    var composer=new TableLayoutPanel{Dock=DockStyle.Fill,AutoSize=true,ColumnCount=2,RowCount=2,Margin=Padding.Empty,Padding=new Padding(0,0,0,6)};
    composer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));composer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
    composeTarget.Text="Desktop 대화 선택 → 메시지 입력 → 보내기 · Ctrl+Enter";composeTarget.AutoSize=true;composeTarget.ForeColor=TrayTheme.Muted;composeTarget.Margin=new Padding(0,0,0,5);
    composer.Controls.Add(composeTarget,0,0);composer.SetColumnSpan(composeTarget,2);
    message.Multiline=true;message.Height=Font.Height*2+16;message.MaxLength=8192;message.ScrollBars=ScrollBars.Vertical;message.Dock=DockStyle.Fill;message.BackColor=TrayTheme.Surface;message.ForeColor=TrayTheme.Text;message.BorderStyle=BorderStyle.FixedSingle;message.Margin=new Padding(0,0,6,0);message.AccessibleName="선택한 Desktop 대화에 보낼 메시지";
    message.AccessibleDescription="보내기를 누르면 선택한 기존 대화의 대기열에 한 번 접수합니다. 대화별 임시 입력은 이 창이 열려 있는 동안 보존됩니다. 자동재개 켜기와 별개이며 기존 모델을 유지합니다. 접수와 응답 완료는 다릅니다.";tips.SetToolTip(message,message.AccessibleDescription);message.TextChanged+=(s,e)=>{if(!swappingDraft)SetButtons();};composer.Controls.Add(message,0,1);
    var sendArea=new FlowLayoutPanel{AutoSize=true,Dock=DockStyle.Fill,Margin=Padding.Empty,WrapContents=false};composer.Controls.Add(sendArea,1,1);
    AddButton(sendArea,send,"보내기",SendMessage,"선택한 Desktop 대화에 입력한 메시지를 한 번 보냅니다. 실행 중이면 앱 대기열에서 기다립니다. 접수 뒤 새 응답을 관측하며 불명 전송은 반복하지 않습니다. Ctrl+Enter로도 보낼 수 있습니다.");
    sendArea.MouseMove+=(s,e)=>{actionHint.Text=send.AccessibleDescription;tips.SetToolTip(sendArea,send.AccessibleDescription);};layout.Controls.Add(composer,0,3);
    var footer=new FlowLayoutPanel{Dock=DockStyle.Fill,AutoSize=true,WrapContents=true,Margin=Padding.Empty,Padding=new Padding(0,3,0,3)};layout.Controls.Add(footer,0,4);
    AddButton(footer,refresh,"새로 고침",()=>LoadRows(),"최근 대화와 등록 상태를 다시 읽습니다. 작업을 실행하거나 설정을 바꾸지 않습니다.");
    AddButton(footer,register,"등록",()=>Act("Register"),"선택한 대화를 자동재개 목록에 추가합니다. 등록 직후에는 꺼짐이며, 2. 자동재개 켜기를 눌러야 대기합니다.");
    AddButton(footer,enable,"자동재개 켜기",()=>Act("Enable"),"미등록 대화는 등록도 함께 처리합니다. 기존 승인 범위에서 이어가도록 대기시킵니다. 한도·연결·기존 보류 조건이 남아 있으면 바로 실행되지 않습니다.");
    AddButton(footer,disable,"자동재개 끄기",()=>Act("Disable"),"다음 자동재개를 막습니다. 지금 실행 중인 작업이나 대화는 종료하지 않습니다.");
    AddButton(footer,resume,"보류 해제",()=>Act("Resume"),"사용자가 필요한 조치를 마친 뒤, 현재 표시된 응답의 보류만 해제합니다. 조건이 맞는 등록 대화에서만 사용할 수 있습니다.");
    AddButton(footer,complete,"추적 완료",()=>Act("Complete"),"이 목록에서 완료로 표시하고 다음 자동재개를 끕니다. 실제 Codex 목표 완료를 선언하거나 실행 중인 작업을 종료하지 않습니다.");
    AddButton(footer,web,"웹 대화 관리",()=>OpenWebSelection(),"기존 AICC 관리 화면에서 ChatGPT Web의 대화를 선택하고 감독 설정을 관리합니다.");
    AddButton(footer,phone,"휴대폰 연결",()=>OpenPhone(),"기존 휴대폰 연결 화면을 엽니다. 연결 링크와 일회용 페어링은 그 화면에서 만듭니다.");
    AddButton(footer,guide,"사용법 · F1",ShowHelp,"각 기능의 역할과 순서, 버튼이 잠긴 이유를 설명합니다. 설정은 바꾸지 않습니다.");
    foreach(var extra in new[]{register,complete,web,phone,guide})footer.Controls.Remove(extra);
    var more=new DarkTrayButton();AddButton(footer,more,"더 보기",()=>{
      var menu=new ContextMenuStrip{BackColor=TrayTheme.Surface,ForeColor=TrayTheme.Text,Renderer=new DarkTrayMenuRenderer()};
      var done=menu.Items.Add("추적 완료",null,(a,b)=>Act("Complete"));done.Enabled=complete.Enabled;
      var open=menu.Items.Add("선택한 대화 열기",null,(a,b)=>OpenSelectedThread());open.Enabled=Selected().Length==1;
      var receipt=menu.Items.Add("메시지 영수증 복사",null,(a,b)=>{var ids=Selected();if(ids.Length==1){var row=rows[ids[0]];Clipboard.SetText("thread="+ids[0]+"\r\noperation="+S(row,"queueOperationId")+"\r\nqueue="+S(row,"queuedMessageId")+"\r\nstate="+S(row,"queueState"));}});receipt.Enabled=Selected().Length==1&&!String.IsNullOrEmpty(S(rows[Selected()[0]],"queueOperationId"));
      menu.Items.Add("대화 ID 복사",null,(a,b)=>{var ids=Selected();if(ids.Length>0)Clipboard.SetText(String.Join(Environment.NewLine,ids));});
      menu.Items.Add("웹 대화 관리",null,(a,b)=>OpenWebSelection());menu.Items.Add("휴대폰 연결",null,(a,b)=>OpenPhone());menu.Items.Add("사용법 · F1",null,(a,b)=>ShowHelp());
      menu.Closed+=(a,b)=>menu.Dispose();menu.Show(more,new Point(0,more.Height));
    },"원래 대화 열기, 메시지 영수증·대화 ID 복사, 추적 완료, 웹·휴대폰 관리와 사용법입니다.");
    footer.MouseMove+=(s,e)=>{var child=footer.GetChildAtPoint(e.Location,GetChildAtPointSkip.Invisible);if(child!=null&&help.ContainsKey(child)){actionHint.Text=child.AccessibleDescription;tips.SetToolTip(footer,child.AccessibleDescription);}};
    actionHint.AutoSize=false;actionHint.Height=Font.Height+8;actionHint.AutoEllipsis=true;actionHint.Dock=DockStyle.Fill;actionHint.ForeColor=TrayTheme.Text;actionHint.Padding=new Padding(0,4,0,4);actionHint.MaximumSize=new Size(1000,0);actionHint.Text="메시지는 보내기 · 자동재개는 켜기 · F1 도움말";layout.Controls.Add(actionHint,0,5);
    notice.AutoSize=false;notice.Height=Font.Height+8;notice.AutoEllipsis=true;notice.Dock=DockStyle.Fill;notice.ForeColor=TrayTheme.Text;notice.Padding=new Padding(0,4,0,4);notice.Text="목록을 읽는 중…";layout.Controls.Add(notice,0,6);
    VisibleChanged+=(s,e)=>{if(Visible)LoadRows();};recent.SelectedIndexChanged+=(s,e)=>SetButtons();SetButtons();
  }
  void AddButton(FlowLayoutPanel panel,Button b,string text,Action action,string description){
    b.Text=text;b.AutoSize=true;b.AutoSizeMode=AutoSizeMode.GrowAndShrink;b.MinimumSize=new Size(76,32);b.Padding=new Padding(8,3,8,3);b.Margin=new Padding(0,0,6,4);b.BackColor=TrayTheme.Surface;b.ForeColor=TrayTheme.Text;b.AccessibleName=text;help[b]=description;b.AccessibleDescription=description;tips.SetToolTip(b,description);
    b.MouseEnter+=(s,e)=>actionHint.Text=b.AccessibleDescription;b.Enter+=(s,e)=>{actionHint.Text=b.AccessibleDescription;tips.Show(b.AccessibleDescription,b,0,b.Height,10000);};b.Leave+=(s,e)=>tips.Hide(b);b.Click+=(s,e)=>{if(b.Enabled)action();};panel.Controls.Add(b);
  }
  void Availability(Button button,bool available,string reason){button.Enabled=available;button.AccessibleDescription=help[button]+(available?"":"\n사용할 수 없는 이유: "+reason);tips.SetToolTip(button,button.AccessibleDescription);}
  protected override bool ProcessCmdKey(ref Message msg,Keys key){if(key==Keys.F1){ShowHelp();return true;}if(key==Keys.F5){LoadRows();return true;}if(key==Keys.Enter&&recent.ContainsFocus){OpenSelectedThread();return true;}if(key==(Keys.Control|Keys.Enter)&&message.ContainsFocus){if(send.Enabled)SendMessage();return true;}return base.ProcessCmdKey(ref msg,key);}
  internal void ShowHelp(){
    string text="메시지: Desktop 대화 1개 선택 → 입력 → 보내기 (Ctrl+Enter)\n자동재개: 대화 선택 → 켜기 (미등록이면 함께 등록)\n\n";
    foreach(var button in new[]{find,send,register,enable,disable,resume,complete,refresh,web,phone})text+=button.Text+"\n"+help[button]+"\n\n";
    text+="버튼이 잠겼다면 대화 선택, 등록 여부와 아래 상태 안내를 확인하세요. 관리기 버전이 다르면 조회와 끄기만 가능하며, 같은 배포본으로 갱신하기 전에는 켜기·재개를 실행하지 않습니다. Desktop의 전달 연결 대기는 '켜짐'과 별개입니다.";
    using(var dialog=new Form{Text="대화 자동재개 사용법",StartPosition=FormStartPosition.CenterParent,Size=new Size(760,560),BackColor=TrayTheme.Background,ForeColor=TrayTheme.Text,Font=Font,ShowInTaskbar=false,AutoScaleMode=AutoScaleMode.Dpi}){
      var body=new TextBox{Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical,Dock=DockStyle.Fill,Text=text.Replace("\n","\r\n"),BackColor=TrayTheme.Surface,ForeColor=TrayTheme.Text,BorderStyle=BorderStyle.None,AccessibleName="각 기능의 역할과 사용 순서"};
      var close=new DarkTrayButton{Text="닫기",Dock=DockStyle.Bottom,Height=42,DialogResult=DialogResult.Cancel,ForeColor=TrayTheme.Text,BackColor=TrayTheme.Surface};
      dialog.Controls.Add(body);dialog.Controls.Add(close);dialog.CancelButton=close;var area=Screen.FromControl(this).WorkingArea;dialog.Size=new Size(Math.Min(dialog.Width,area.Width),Math.Min(dialog.Height,area.Height));dialog.ShowDialog(this);
    }
  }
  protected override void Dispose(bool disposing){if(disposing){rowSize.Dispose();tips.Dispose();foreach(var extra in new[]{register,complete,web,phone,guide})extra.Dispose();}base.Dispose(disposing);}
  void OpenPhone(){if(OwnerToolRequested!=null)OwnerToolRequested("phone");else notice.Text="설치된 휴대폰 관리 연결이 없습니다 · 도구 탭에서 확인하세요";}
  void OpenWebSelection(){if(OwnerToolRequested!=null)OwnerToolRequested("aicc");else notice.Text="설치된 AICC 관리 연결이 없습니다 · 도구 탭에서 확인하세요";}
  static string Q(string value){if(value.IndexOf('"')>=0||value.IndexOf('\r')>=0||value.IndexOf('\n')>=0)throw new InvalidOperationException("Invalid argument");return "\""+value+"\"";}
  Dictionary<string,object> Call(string action,string id,string terminal=null,string file=null,string operation=null){
    var info=TrayUtf8Process.Helper(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center","toolchain","pwsh-7.6.6","runtime","pwsh.exe"),helper,action,id,terminal,file,operation);
    using(var p=Process.Start(info)){var output=p.StandardOutput.ReadToEndAsync();var error=p.StandardError.ReadToEndAsync();if(!p.WaitForExit(45000)){if(action=="Overview"||action=="FindThread"||action=="Status"){try{p.Kill();}catch{}}throw new InvalidOperationException("응답 대기 시간 초과 · 원 결과를 보존하고 현재 상태를 다시 조회하세요");}if(p.ExitCode!=0)throw new InvalidOperationException("요청을 처리하지 못했습니다 · 기존 설정은 확인이 필요합니다");return new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(output.Result);}
  }
  string[] Selected(){var ids=new List<string>();foreach(ListViewItem item in recent.SelectedItems)ids.Add(Convert.ToString(item.Tag));return ids.ToArray();}
  static string S(Dictionary<string,object> row,string key){object value;return row.TryGetValue(key,out value)&&value!=null?Convert.ToString(value):"";}
  static bool B(Dictionary<string,object> row,string key){object value;return row.TryGetValue(key,out value)&&value is bool&&(bool)value;}
  static IEnumerable<Dictionary<string,object>> ArrayRows(Dictionary<string,object> data,string key){object value;if(data.TryGetValue(key,out value)&&value is System.Collections.IEnumerable)foreach(object item in (System.Collections.IEnumerable)value){var row=item as Dictionary<string,object>;if(row!=null)yield return row;}}
  static string NextStep(Dictionary<string,object> row){
    string state=S(row,"availabilityState");
    if(state=="ARCHIVED_THREAD_HOLD")return "보관함으로 이동한 대화입니다. Codex 보관함에서 직접 복원한 뒤 새로 고치세요. 자동 복원하지 않습니다.";
    if(state=="ROLLOUT_MISSING_HOLD")return "저장된 대화 기록을 찾지 못했습니다. 원래 대화를 확인하세요. 등록과 전송 기록은 보존됩니다.";
    if(state=="THREAD_SCOPE_HOLD")return "등록된 작업 폴더와 대화 기록이 다릅니다. 정확한 대화·폴더를 확인해야 하며 자동으로 바꾸지 않습니다.";
    if(state=="THREAD_OBSERVATION_HOLD")return "이 대화의 기록을 읽지 못했습니다. 다른 대화 감시는 계속합니다. 잠시 뒤 새로 고치세요.";
    if(S(row,"state")=="DESKTOP_FAILURE_HOLD")return "원래 대화에서 전송 오류와 마지막 작업을 확인하세요. 일반 대기와 다르며 자동 재전송하지 않습니다.";
    string queue=S(row,"queueState");
    if(queue=="QUEUE_ACCEPTED")return "메시지 접수됨 · 앱이 처리할 때까지 대기합니다. 접수는 응답 완료가 아닙니다.";
    if(queue=="QUEUE_TURN_ACTIVE")return "해당 메시지의 새 응답이 시작됐습니다. 대화에서 진행 내용을 볼 수 있습니다.";
    if(queue=="QUEUE_DELIVERY_UNCERTAIN")return "전달 여부 불명 · 같은 메시지를 다시 보내지 말고 새로 고침 또는 원래 대화에서 확인하세요.";
    if(queue=="QUEUE_TURN_COMPLETED")return "해당 응답이 끝났습니다. 요청한 전체 업무의 완료 여부는 원래 대화에서 확인하세요.";
    if(queue=="QUEUE_TURN_INTERRUPTED")return "해당 응답이 중단됐습니다. 자동으로 다시 보내지 않습니다. 원래 대화에서 원인을 확인하세요.";
    return S(row,"executionSurface")=="desktop"?"아래에 메시지를 입력해 기존 대화에 보낼 수 있습니다. 자동재개는 별도 경로·한도 조건을 따릅니다.":"기존 등록 경로 · 메시지 보내기는 Desktop 대화에서 사용합니다.";
  }
  void SetButtons(){
    if(rebuilding)return;
    string[] picked=Selected();string target=picked.Length==1?picked[0]:"";
    if(target!=draftTarget){if(draftTarget.Length>0)drafts[draftTarget]=message.Text;draftTarget=target;swappingDraft=true;try{string saved;message.Text=target.Length>0&&drafts.TryGetValue(target,out saved)?saved:"";}finally{swappingDraft=false;}}
    composeTarget.Text=target.Length>0?"받는 대화 · "+target.Substring(0,8)+" · Ctrl+Enter로 보내기":"Desktop 대화 하나를 선택하세요 · 입력은 대화별로 보존";
    Guid searchId;Availability(find,!busy&&protocolOk&&Guid.TryParse(filter,out searchId),busy?"조회 또는 변경이 진행 중입니다.":!protocolOk?"등록된 관리기를 먼저 갱신하세요.":"전체 대화 ID 또는 codex://threads 링크를 입력하세요.");
    recent.Enabled=!busy;search.ReadOnly=busy;
    var selected=new List<Dictionary<string,object>>();foreach(string id in Selected()){Dictionary<string,object> row;if(rows.TryGetValue(id,out row))selected.Add(row);}
    bool any=selected.Count>0,allRegistered=any,allOff=any,allOn=any,holds=any,allAvailable=any;
    foreach(var row in selected){allAvailable&=!B(row,"registered")||S(row,"availabilityState")=="ACTIVE";allRegistered&=B(row,"registered");allOff&=!B(row,"enabled");allOn&=B(row,"enabled");holds&=S(row,"state")=="REQUIRED_ACTION_HOLD"&&!String.IsNullOrEmpty(S(row,"terminalSha256"));}
    string prerequisite=busy?"조회 또는 변경이 진행 중입니다.":!any?"먼저 목록에서 대화를 선택하세요.":!protocolOk?"트레이와 관리기 버전이 다릅니다. 상태 조회와 끄기만 가능합니다.":"";
    Availability(refresh,!busy,"조회 또는 변경이 진행 중입니다.");
    Availability(register,!busy&&protocolOk&&any&&!allRegistered,prerequisite!=""?prerequisite:"선택한 대화가 이미 등록돼 있습니다.");
    Availability(enable,!busy&&protocolOk&&any&&allOff&&allAvailable,prerequisite!=""?prerequisite:"이미 켜진 대화가 포함돼 있습니다. 꺼진 등록 대화만 선택하세요.");
    Availability(disable,!busy&&allRegistered&&allOn,busy?"조회 또는 변경이 진행 중입니다.":!any?"먼저 목록에서 대화를 선택하세요.":!allRegistered?"등록된 대화만 선택하세요.":"자동재개가 켜진 대화만 선택하세요.");
    Availability(resume,!busy&&protocolOk&&allRegistered&&holds&&allAvailable,prerequisite!=""?prerequisite:"현재 응답의 보류가 확인된 등록 대화만 선택하세요. 다른 대기 상태는 이 버튼으로 해제하지 않습니다.");
    Availability(complete,!busy&&protocolOk&&allRegistered,prerequisite!=""?prerequisite:"등록된 대화만 추적 완료로 표시할 수 있습니다.");
    string sendReason=prerequisite!=""?prerequisite:!queueSupported?"관리기를 메시지 보내기가 포함된 배포본으로 갱신해야 합니다.":refreshRequired?"전송 결과를 새로 고침으로 먼저 확인하세요.":selected.Count!=1?"보낼 Desktop 대화를 하나만 선택하세요.":S(selected[0],"executionSurface")!="desktop"?"Desktop에서 만든 대화를 선택하세요.":!allAvailable?"보관·누락·작업 폴더 상태를 먼저 확인하세요.":queuePending?"앞선 전송의 결과를 기다리거나 원래 대화에서 확인하세요.":String.IsNullOrWhiteSpace(message.Text)?"아래 입력란에 보낼 내용을 적으세요.":"";
    Availability(send,sendReason=="",sendReason);message.ReadOnly=busy||target.Length==0;
    Availability(web,!busy,"조회 또는 변경이 진행 중입니다.");Availability(phone,!busy,"조회 또는 변경이 진행 중입니다.");
    string details=!protocolOk?"관리기 버전 불일치: 조회·끄기는 가능 / 등록·켜기·보류 해제·추적 완료는 잠김\r\n":"";
    if(!any)details+="목록에서 대화를 선택하세요. Ctrl·Shift로 여러 대화를 고를 수 있습니다.\r\n제목·ID로 찾은 뒤 켜기를 누르세요. 미등록 대화는 함께 등록합니다.";
    else{
      details+=selected.Count+"개 선택 · "+(!allRegistered?"켜기를 누르면 등록도 함께 처리":"등록됨 · 켜기 / 끄기")+"\r\n";
      for(int i=0;i<Math.Min(2,selected.Count);i++){var row=selected[i];details+=S(row,"title")+" · "+S(row,"threadId")+"\r\n"+NextStep(row)+" · "+StateText(S(row,"state"))+"\r\n";}
      if(selected.Count>2)details+="나머지 "+(selected.Count-2)+"개는 목록의 현재 상태를 확인하세요.";
    }
    if(!send.Enabled)details+="\r\n보내기: "+sendReason;
    selectionInfo.Text=details;
  }
  internal void LoadRows(){
    if(busy)return;busy=true;SetButtons();notice.Text="최근 대화와 등록 상태 조회 중…";
    ThreadPool.QueueUserWorkItem(_=>{try{
      var overview=Call("Overview",null);var status=(Dictionary<string,object>)overview["status"];
      if(IsDisposed)return;BeginInvoke((Action)(()=>{
        protocolOk=B(status,"protocolMatch");queueSupported=B(status,"queueMessageSupported");queuePending=B(status,"queueDispatchPending");refreshRequired=false;nextQueueRefresh=DateTime.UtcNow.AddSeconds(15);
        var registered=new Dictionary<string,Dictionary<string,object>>();foreach(var entry in ArrayRows(status,"threads"))registered[S(entry,"threadId")]=entry;
        rows.Clear();foreach(var cached in resolved)rows[cached.Key]=cached.Value;
        foreach(var row in ArrayRows(overview,"candidates")){
          string id=S(row,"threadId");Dictionary<string,object> entry;
          if(registered.TryGetValue(id,out entry)){
            row["registered"]=true;
            foreach(string key in new[]{"enabled","state","observedAt","nextCheckAt","nextResetAt","terminalSha256","executionSurface","availabilityState","queueProgress"}){object value;if(entry.TryGetValue(key,out value))row[key]=value;}
          }
          CopyQueueProgress(row);rows[id]=row;
        }
        // Older registered conversations must remain visible after merging the resume view.
        foreach(var pair in registered){
          if(String.IsNullOrWhiteSpace(pair.Key)||rows.ContainsKey(pair.Key))continue;
          var registeredRow=new Dictionary<string,object>(pair.Value);
          registeredRow["registered"]=true;
          if(String.IsNullOrWhiteSpace(S(registeredRow,"title")))registeredRow["title"]="등록 대화 · "+pair.Key;
          CopyQueueProgress(registeredRow);rows[pair.Key]=registeredRow;
        }
        FilterRows();busy=false;SetButtons();notice.ForeColor=protocolOk?TrayTheme.Text:TrayTheme.Warning;
        notice.Text=protocolOk?rows.Count+"개 · "+DateTime.UtcNow.AddHours(9).ToString("HH:mm:ss")+" KST 조회 · "+(queueSupported?"메시지 접수와 응답 상태를 구분합니다":"메시지 기능은 관리기 갱신 필요"):"관리기 버전이 달라 켜기·재개가 잠겼습니다. 조회와 자동재개 끄기는 사용할 수 있습니다.";
      }));
    }catch(Exception){if(!IsDisposed)try{BeginInvoke((Action)(()=>{busy=false;nextQueueRefresh=DateTime.UtcNow.AddSeconds(30);SetButtons();notice.Text="목록 조회 실패 · 현재 설정과 입력은 보존됩니다";}));}catch(InvalidOperationException){}}});
  }
  static void CopyQueueProgress(Dictionary<string,object> row){
    object raw;var progress=row.TryGetValue("queueProgress",out raw)?raw as Dictionary<string,object>:null;
    if(progress==null)return;row["queueState"]=S(progress,"state");row["queuePending"]=B(progress,"pending");row["queueOperationId"]=S(progress,"id");row["queuedMessageId"]=S(progress,"queuedMessageId");
  }
  void FilterRows(){
    bool wasRebuilding=rebuilding;rebuilding=true;
    recent.BeginUpdate();var selected=new HashSet<string>(Selected());recent.Items.Clear();
    foreach(var row in rows.Values){
      string id=S(row,"threadId"),title=S(row,"title");
      if(viewFilter.SelectedIndex==1&&!B(row,"registered")||viewFilter.SelectedIndex==2&&!B(row,"enabled")||viewFilter.SelectedIndex==3&&!S(row,"state").Contains("HOLD")&&!S(row,"state").Contains("UNCERTAIN"))continue;
      if(filter.Length>0&&(title+" "+id).IndexOf(filter,StringComparison.OrdinalIgnoreCase)<0)continue;
      var item=new ListViewItem(title){Tag=id,ToolTipText=title+"\n"+id+"\n"+NextStep(row)};
      item.SubItems.Add(B(row,"enabled")?"켜짐":B(row,"registered")?"꺼짐":"미등록");item.SubItems.Add(RowState(row));
      recent.Items.Add(item);item.Selected=selected.Contains(id);
    }
    recent.EndUpdate();rebuilding=wasRebuilding;
    int registeredCount=0,enabledCount=0,holdCount=0;foreach(var row in rows.Values){if(B(row,"registered"))registeredCount++;if(B(row,"enabled"))enabledCount++;if(S(row,"state").Contains("HOLD")||S(row,"state").Contains("UNCERTAIN"))holdCount++;}
    overview.Text="표시 "+recent.Items.Count+"개 · 재개 등록 "+registeredCount+" · 켜짐 "+enabledCount+" · 확인 필요 "+holdCount;SetButtons();
  }
  void OpenSelectedThread(){var ids=Selected();if(busy||ids.Length!=1)return;try{Process.Start(new ProcessStartInfo("codex://threads/"+new Guid(ids[0]).ToString()){UseShellExecute=true});}catch{notice.Text="대화 링크를 열지 못했습니다 · 대화 ID로 찾아주세요";}}
  void FindThread(){
    Guid parsed;if(busy||!Guid.TryParse(filter,out parsed))return;string id=parsed.ToString();busy=true;SetButtons();notice.Text="정확한 ID로 저장된 대화 조회 중…";
    ThreadPool.QueueUserWorkItem(_=>{try{var result=Call("FindThread",id);if(IsDisposed)return;BeginInvoke((Action)(()=>{busy=false;object value;var row=result.TryGetValue("candidate",out value)?value as Dictionary<string,object>:null;if(!B(result,"found")||row==null){SetButtons();notice.Text="해당 활성 대화를 찾지 못했습니다 · ID·보관 여부·보호 대상을 확인하세요";return;}
      object raw;var progress=row.TryGetValue("queueProgress",out raw)?raw as Dictionary<string,object>:null;if(progress!=null){row["queueState"]=S(progress,"state");row["queuePending"]=B(progress,"pending");row["queueOperationId"]=S(progress,"id");row["queuedMessageId"]=S(progress,"queuedMessageId");}
      if(resolved.Count>=16&&!resolved.ContainsKey(id))resolved.Clear();resolved[id]=row;rows[id]=row;FilterRows();foreach(ListViewItem item in recent.Items){item.Selected=Convert.ToString(item.Tag)==id;if(item.Selected){item.Focused=true;item.EnsureVisible();}}SetButtons();notice.Text="대화 찾음 · 등록·전송은 실행하지 않았습니다";}));
    }catch(Exception){if(!IsDisposed)try{BeginInvoke((Action)(()=>{busy=false;SetButtons();notice.Text="대화 ID 조회 실패 · 기존 목록과 입력은 보존됩니다";}));}catch(InvalidOperationException){}}});
  }
  static string When(string observed,string updated){DateTime at;return DateTime.TryParse(String.IsNullOrWhiteSpace(observed)?updated:observed,out at)?at.ToUniversalTime().AddHours(9).ToString("MM.dd HH:mm:ss"):"관찰 시각 없음";}
  static string RowState(Dictionary<string,object> row){switch(S(row,"queueState")){case "QUEUE_ACCEPTED":return "메시지 접수 · 응답 대기";case "QUEUE_TURN_ACTIVE":return "메시지 응답 중";case "QUEUE_TURN_COMPLETED":return "메시지 응답 완료";case "QUEUE_TURN_INTERRUPTED":return "메시지 응답 중단";case "QUEUE_DELIVERY_UNCERTAIN":return "메시지 전달 불명 · 재전송 보류";default:return StateText(S(row,"state"));}}
  internal void TickQueueFeedback(){if(Visible&&queueSupported&&queuePending&&!busy&&DateTime.UtcNow>=nextQueueRefresh)LoadRows();}
  void SendMessage(){
    var ids=Selected();if(!send.Enabled||ids.Length!=1)return;string id=ids[0],text=message.Text.Trim(),operation=Guid.NewGuid().ToString();bool registered=B(rows[id],"registered");
    busy=true;refreshRequired=true;SetButtons();notice.Text="메시지 접수 중 · "+id.Substring(0,8);
    ThreadPool.QueueUserWorkItem(_=>{try{
      string root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center","control-plane","codex-continuity","requests");Directory.CreateDirectory(root);string file=Path.Combine(root,operation+".txt");
      using(var stream=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None))using(var writer=new StreamWriter(stream,new System.Text.UTF8Encoding(false,true)))writer.Write(text);
      if(!registered)Call("Register",id);var receipt=Call("QueueMessage",id,null,file,operation);bool accepted=!String.IsNullOrEmpty(S(receipt,"queuedMessageId"))||S(receipt,"state")=="QUEUE_TURN_ACTIVE"||S(receipt,"state")=="QUEUE_TURN_COMPLETED";
      if(!IsDisposed)BeginInvoke((Action)(()=>{busy=false;queuePending=true;nextQueueRefresh=DateTime.UtcNow.AddSeconds(15);if(accepted&&message.Text.Trim()==text)message.Clear();SetButtons();notice.Text=accepted?"메시지 접수됨 · "+id.Substring(0,8)+" · 응답 완료는 별도 표시":"전달 여부 불명 · 새로 고침으로 확인 · 자동 재전송 안 함";LoadRows();}));
    }catch(Exception){if(!IsDisposed)try{BeginInvoke((Action)(()=>{busy=false;queuePending=true;nextQueueRefresh=DateTime.UtcNow.AddSeconds(15);SetButtons();notice.Text="전송 결과 확인 필요 · 입력 보존 · 새로 고침 후 원래 대화를 확인하세요";}));}catch(InvalidOperationException){}}});
  }
  static string StateText(string value){switch(value){case "QUEUED":return "재개 예약됨";case "ARCHIVED_THREAD_HOLD":return "보관됨 · 자동재개 안 함";case "ROLLOUT_MISSING_HOLD":return "대화 기록 없음 · 자동재개 보류";case "THREAD_SCOPE_HOLD":return "등록 작업 폴더 확인 필요";case "THREAD_OBSERVATION_HOLD":return "대화 읽기 오류 · 개별 보류";case "DESKTOP_FAILURE_HOLD":return "전송 오류 · 원래 대화에서 확인";case "DESKTOP_QUEUE_WAIT":return "공식 전달자 연결 필요";case "DESKTOP_DELIVERY_ACCEPTED":return "Desktop 전달 확인";case "DESKTOP_TURN_ACTIVE":return "Desktop 작업 중";case "REQUIRED_ACTION_HOLD":return "보류 · 해결 후 재개 가능";case "QUOTA_WAIT":return "토큰 갱신 대기";case "RESUMING_OCX":return "OCX 작업 재개 중";case "REGISTERED_OWNER_ACTIVE":case "EXACT_THREAD_OWNER_ACTIVE":return "기존 대화 실행 중";case "DISABLED":return "꺼짐";case "COMPLETE":return "추적 완료";case "WATCHING":return "재개 조건 감시 중";case "DELIVERY_UNCERTAIN":return "결과 불명 · 자동 전송 보류";case "OCX_WAIT":return "OCX 연결 대기";case "TURN_TERMINAL":return "다음 작업 대기";default:return String.IsNullOrEmpty(value)?"미등록":"재개 조건 대기 · "+value;}}
  void Act(string action){var ids=Selected();if(busy||ids.Length==0)return;
    if((action=="Enable"||action=="Resume")&&MessageBox.Show(this,ids.Length+"개 대화의 기존 승인 범위에서 미완료 작업을 이어갑니다.\nCLI는 OCX Sol 6.1 High, Desktop은 앱의 기존 모델 경로를 유지합니다.\n켜기는 기존 보류를 유지합니다. 보류 해제는 지금 표시된 응답에만 적용합니다.\n전달 불명 요청을 반복하지 않으며 끄기 또는 추적 완료까지 큐를 유지합니다.","선택한 대화 자동재개",MessageBoxButtons.OKCancel)!=DialogResult.OK)return;
    var terminals=new Dictionary<string,string>();var unregistered=new HashSet<string>();foreach(string id in ids){terminals[id]=S(rows[id],"terminalSha256");if(!B(rows[id],"registered"))unregistered.Add(id);}
    busy=true;SetButtons();notice.Text=ids.Length+"개 대화 설정 변경 중…";ThreadPool.QueueUserWorkItem(_=>{int done=0;try{foreach(string id in ids){if(action=="Register"&&B(rows[id],"registered"))continue;if(action=="Enable"&&unregistered.Contains(id))Call("Register",id);Call(action,id,action=="Resume"?terminals[id]:null);done++;}if(!IsDisposed)BeginInvoke((Action)(()=>{busy=false;LoadRows();}));}catch(Exception){if(!IsDisposed)try{BeginInvoke((Action)(()=>{busy=false;SetButtons();notice.Text=done+"개 저장 후 중단 · 같은 요청을 반복하기 전에 목록을 조회하세요";}));}catch(InvalidOperationException){}}});
  }
}
