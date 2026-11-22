using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Text;
using System.Windows.Forms;

internal sealed partial class StatusPopup {
  const int CompactWidth=600, CompactFooter=58, CompactCardTop=88;
  bool compactReady,policyLoading,policyDirty;
  int textPercent=100;bool showRemaining;
  int CompactRow{get{return (int)Math.Ceiling(136*textPercent/100f);}}
  int laidOutPage=-1,laidOutRows=-1;
  readonly Panel accountActions=new Panel();
  readonly Label selectedAccountCaption=new Label{AutoEllipsis=true};
  int compactPage,hoverAccount=-1;
  string pickedAccount="";
  readonly Dictionary<int,Font[]> typefaces=new Dictionary<int,Font[]>();
  readonly List<Dictionary<string,object>> orderedAccounts=new List<Dictionary<string,object>>();
  ComboBox accountPicker;
  ListBox routeOrder;
  Button priorityFirst,priorityLast,orderReset;
  readonly Label orderFeedback=new Label{AutoEllipsis=true};
  bool orderDirty,orderConflict,orderSaving;
  string orderBaseline="",orderBaselineIds="";
  bool selectingAccount;
  string pickerSignature="",orderSignature="";
  Font small=new Font(TrayTheme.KoreanFont,9.25f);
  Font quotaNumber=new Font(TrayTheme.DisplayFont,16f,FontStyle.Regular);
  readonly List<Button> tabs=new List<Button>();
  readonly int[] tabPages={0,1,2,6,9,7,5,10,8};
  AiccCodexCliDialog cliPage;
  Control coworkPage; RichTextBox coworkText; TextBox coworkSearch; ComboBox coworkScope; Label coworkStatus; FlowLayoutPanel coworkActions;
  Control warningPage,settingsPage; Panel settingsContent; Button settingsCopy; Label settingsState;
  bool settingsLayout;
  readonly List<Control[]> settingsRows=new List<Control[]>();
  readonly Dictionary<Button,Func<bool>> settingsSelections=new Dictionary<Button,Func<bool>>();
  internal Action ExitRequested;
  CodexConversationHost conversationPanel;
  readonly Panel navigation=new Panel{Dock=DockStyle.Top};
  Button loginAccount,accountMore,queueGuide;
  Button useAccount,pauseAccount,autoAccount,resetAccount,applyPriority,copyStatus,reconcile,slack,guide,applyPolicy;
  NumericUpDown priority,shortLimit,longLimit;
  ComboBox shortRule,longRule;
  internal string ResourceSummary="자원 사용량 확인 중";

  readonly Label quotaStamp=new Label{AutoSize=false},collectorStamp=new Label{AutoSize=false};
  string ViewPreferencesPath(){
    string state=Environment.GetEnvironmentVariable("AICC_STATE_ROOT");
    if(String.IsNullOrWhiteSpace(state))state=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center");
    return System.IO.Path.Combine(System.IO.Path.GetFullPath(state),"status-tray","ui-preferences.json");
  }
  void ReadViewPreferences(){
    try{
      string path=ViewPreferencesPath();var info=new System.IO.FileInfo(path);
      if(!info.Exists||info.Length>4096||(info.Attributes&System.IO.FileAttributes.ReparsePoint)!=0)return;
      var prefs=new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<Dictionary<string,object>>(System.IO.File.ReadAllText(path));
      int size;if(Int32.TryParse(S(prefs,"textPercent",""),out size)&&(size==100||size==110||size==120))textPercent=size;
      showRemaining=Flag(prefs,"showRemaining");
      object effect;if(prefs.TryGetValue("glassEnabled",out effect)&&effect is bool)glassEnabled=(bool)effect;
    }catch{}
  }
  void SaveViewPreferences(){
    try{
      string path=ViewPreferencesPath(),directory=System.IO.Path.GetDirectoryName(path);
      System.IO.Directory.CreateDirectory(directory);
      if((System.IO.File.GetAttributes(directory)&System.IO.FileAttributes.ReparsePoint)!=0)return;
      if(System.IO.File.Exists(path)&&(System.IO.File.GetAttributes(path)&System.IO.FileAttributes.ReparsePoint)!=0)return;
      string temporary=path+"."+Guid.NewGuid().ToString("N")+".tmp";
      System.IO.File.WriteAllText(temporary,new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(
        new Dictionary<string,object>{{"schemaVersion",1},{"textPercent",textPercent},{"showRemaining",showRemaining},{"glassEnabled",glassEnabled}}),new System.Text.UTF8Encoding(false));
      if(System.IO.File.Exists(path))System.IO.File.Replace(temporary,path,null);else System.IO.File.Move(temporary,path);
    }catch{ShowNotice("화면 설정을 저장하지 못했습니다. 이번 실행에만 적용합니다.");}
  }
  void AddViewOptions(ContextMenuStrip menu){
    var size=new ToolStripMenuItem("글자 크기");
    foreach(int percent in new[]{100,110,120}){
      int selected=percent;var item=new ToolStripMenuItem(percent+"%"+(percent==100?" · 기본":"")){Checked=textPercent==percent};
      item.Click+=(s,e)=>SetTextPercent(selected);size.DropDownItems.Add(item);
    }
    menu.Items.Add(size);
    var metric=new ToolStripMenuItem("사용량 / 잔여량");
    foreach(bool remaining in new[]{false,true}){
      bool selected=remaining;var item=new ToolStripMenuItem(remaining?"남은 한도 표시":"사용한 한도 표시"){Checked=showRemaining==remaining};
      item.Click+=(s,e)=>{showRemaining=selected;SaveViewPreferences();RenderState();ShowNotice(remaining?"남은 한도 기준으로 표시합니다":"사용한 한도 기준으로 표시합니다");};metric.DropDownItems.Add(item);
    }
    menu.Items.Add(metric);
  }
  void SetTextPercent(int value){
    if(value!=100&&value!=110&&value!=120||textPercent==value)return;
    textPercent=value;ApplyTypography(true);ShowNotice("글자 크기 "+value+"% 적용");
  }
  void ApplyControlTypeface(Control parent){
    foreach(Control control in parent.Controls){
      if(control==pin)control.Font=icons;
      else control.Font=control==quotaStamp||control==collectorStamp||control==selectedAccountCaption?small:body;
      if(control.HasChildren)ApplyControlTypeface(control);
    }
  }
  void ApplyTypography(bool save){
    // WinForms can retain an equal Font instead of replacing it. Keep all three
    // size sets alive until the controls have been disposed; never retire a
    // shared native HFONT while a hidden ComboBox/NumericUpDown still uses it.
    if(typefaces.Count==0)typefaces.Add(100,new[]{body,bold,heading,small,quotaNumber});
    Font[] faces;
    if(!typefaces.TryGetValue(textPercent,out faces)){
      float zoom=textPercent/100f;
      faces=new[]{new Font(TrayTheme.KoreanFont,10f*zoom),
        new Font(TrayTheme.KoreanFont,10.25f*zoom,FontStyle.Bold),
        new Font(TrayTheme.KoreanFont,16f*zoom,FontStyle.Bold),
        new Font(TrayTheme.KoreanFont,9.25f*zoom),new Font(TrayTheme.DisplayFont,16f*zoom,FontStyle.Regular)};
      typefaces.Add(textPercent,faces);
    }
    body=faces[0];bold=faces[1];heading=faces[2];small=faces[3];quotaNumber=faces[4];
    Font=body;ApplyControlTypeface(this);
    if(routeOrder!=null)routeOrder.ItemHeight=Math.Max(P(OrderRowHeight()),body.Height+P(8));
    if(compactReady){LayoutExpandedDpi();RenderState();}
    if(save)SaveViewPreferences();
  }
  void InitializeExpandedUI(){
    compactReady=true;Controls.Add(navigation);Controls.Add(accountActions);
    canvas.Dock=footer.Dock=navigation.Dock=DockStyle.None;
    accountActions.Controls.Add(selectedAccountCaption);selectedAccountCaption.Font=small;
    navigation.Controls.Add(pin);((DarkTrayButton)pin).Primary=false;
    ((DarkTrayButton)refresh).Primary=false;
    footer.Controls.Add(quotaStamp);footer.Controls.Add(collectorStamp);
    tabs.Add(MakeButton(navigation,"계정",()=>SetCompactPage(0)));
    tabs.Add(MakeButton(navigation,"연결",()=>SetCompactPage(1)));
    tabs.Add(MakeButton(navigation,"자동 전환",()=>SetCompactPage(2)));
    // Resume status is part of the conversation list; old page 4 routes there.
    tabs.Add(MakeButton(navigation,"대화 · 재개",()=>SetCompactPage(6)));
    tabs.Add(MakeButton(navigation,"CLI",()=>SetCompactPage(9)));
    tabs.Add(MakeButton(navigation,"사전 경고",()=>SetCompactPage(7)));
    tabs.Add(MakeButton(navigation,"도구",()=>SetCompactPage(5)));
    tabs.Add(MakeButton(navigation,"AICC 관리기",()=>SetCompactPage(10)));
    tabs.Add(MakeButton(navigation,"설정",()=>SetCompactPage(8)));
    copyStatus=MakeButton(footer,"복사",CopyStatus);
    reconcile=MakeButton(footer,"반영 확인",()=>{if(ReconcileRequested!=null)ReconcileRequested();});
    more.Text="설정";
    useAccount=MakeButton(accountActions,"사용",()=>RunSelected("use",null));
    pauseAccount=MakeButton(accountActions,"사용 중지",()=>RunSelected(Selected()!=null&&Flag(Selected(),"paused")?"resume":"pause",null));
    autoAccount=MakeButton(accountActions,"자동 선택",()=>{
      var current=accountRows.Find(r=>Flag(r,"active"));
      if(current==null){ShowNotice("사용 중인 계정을 확인할 수 없습니다.");return;}
      RequestAccount(current,"unpin",null);
    });
    resetAccount=MakeButton(accountActions,"초기화권",OpenCreditInventory);
    loginAccount=MakeButton(contentSurface,"로그인 관리",OpenSelectedLogin);
    accountMore=MakeButton(accountActions,"관리",()=>{var row=Selected();if(row!=null)ShowMenu(AccountMenu(row),accountMore);});
    tips.SetToolTip(loginAccount,"공식 OCX 관리 화면에서 선택한 계정의 재로그인을 진행합니다.");
    tips.SetToolTip(accountMore,"계정별 한도 사전 차단 켜기/끄기 · 사용 순서 · 자동 선택 · 로그인 관리");
    priority=new NumericUpDown{Minimum=-100,Maximum=100,Font=body,BackColor=TrayTheme.Surface,ForeColor=TrayTheme.Text,TabStop=true};
    contentSurface.Controls.Add(priority);
    applyPriority=MakeButton(contentSurface,"저장",SaveAccountOrder);
    priority.ValueChanged+=(s,e)=>{if(!selectingAccount)UpdateSelectedControls();};
    accountPicker=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,FlatStyle=FlatStyle.Flat,Font=body,AccessibleName="전환할 계정 선택"};
    accountActions.Controls.Add(accountPicker);
    accountPicker.SelectedIndexChanged+=(s,e)=>{
      if(selectingAccount||accountPicker.SelectedIndex<0||accountPicker.SelectedIndex>=accountRows.Count)return;
      Pick(accountPicker.SelectedIndex);
    };
    routeOrder=new ListBox{BorderStyle=BorderStyle.None,IntegralHeight=false,DrawMode=DrawMode.OwnerDrawFixed,Font=body,AccessibleName="계정 사용 순서. 위에 있는 계정부터 우선 사용"};
    routeOrder.DrawItem+=DrawOrderItem;
    routeOrder.KeyDown+=(s,e)=>{
      if(e.Alt&&(e.KeyCode==Keys.Up||e.KeyCode==Keys.Down)){MoveAccountOrder(e.KeyCode==Keys.Up?-1:1);e.Handled=true;e.SuppressKeyPress=true;}
    };
    contentSurface.Controls.Add(routeOrder);
    routeOrder.SelectedIndexChanged+=(s,e)=>{
      if(selectingAccount||routeOrder.SelectedIndex<0||routeOrder.SelectedIndex>=orderedAccounts.Count)return;
      string id=S(orderedAccounts[routeOrder.SelectedIndex],"identityHash","");
      int index=accountRows.FindIndex(r=>S(r,"identityHash","")==id);
      if(index>=0)Pick(index);
    };
    priorityFirst=MakeButton(contentSurface,"↑ 위로",()=>MoveAccountOrder(-1));
    priorityLast=MakeButton(contentSurface,"↓ 아래로",()=>MoveAccountOrder(1));
    orderReset=MakeButton(contentSurface,"되돌리기",()=>{
      orderDirty=orderConflict=false;orderBaseline="";UpdateSelectedControls();ShowNotice("현재 저장된 순서를 불러왔습니다.");
    });
    contentSurface.Controls.Add(orderFeedback);
    tips.SetToolTip(routeOrder,"계정을 선택한 뒤 위로·아래로 이동하고 순서 저장을 누르세요. Alt+위/아래도 사용할 수 있습니다.");
    tips.SetToolTip(applyPriority,"화면에서 바꾼 순서를 OCX에 저장합니다. 현재 사용 계정은 바꾸지 않습니다.");
    slack=MakeButton(contentSurface,"Slack 알림 보기",()=>{if(SlackRequested!=null)SlackRequested();});
    guide=MakeButton(contentSurface,"사용 설명서",()=>{if(GuideRequested!=null)GuideRequested();});
    queueGuide=MakeButton(contentSurface,"큐 제어 안내",()=>MessageBox.Show(this,
      "작업 등록·정확 대상 배정·취소는 기존 Chrome Queue 확장 사이드패널의 정식 제어에서 수행합니다.\n"+
      "트레이는 원장 요약과 익명화된 대상·상태만 조회합니다. UNKNOWN/발신 불명은 재전송하지 않습니다.\n"+
      "일반 Chat AICC에는 전용 queue mutation 도구가 아직 노출되지 않았습니다.",
      "기존 작업큐 사용 경로",MessageBoxButtons.OK,MessageBoxIcon.Information));
    queueGuide.AccessibleName="Chrome Queue 정식 조작 안내";
    tips.SetToolTip(queueGuide,"기존 확장 사이드패널의 등록·조회·일시 중지·취소만 안내합니다. 트레이에서 발신하지 않습니다.");
    shortLimit=new NumericUpDown{Minimum=1,Maximum=100,Font=body};
    longLimit=new NumericUpDown{Minimum=1,Maximum=100,Font=body};
    shortRule=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,DrawMode=DrawMode.OwnerDrawFixed,FlatStyle=FlatStyle.Flat,Font=body};
    longRule=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,DrawMode=DrawMode.OwnerDrawFixed,FlatStyle=FlatStyle.Flat,Font=body};
    foreach(var selector in new[]{shortRule,longRule}){
      selector.Items.AddRange(new object[]{"다음 계정으로 전환","새 요청 중지"});
      selector.SelectedIndex=0;
      selector.DrawItem+=DrawRuleItem;
      selector.SelectedIndexChanged+=(s,e)=>{if(!policyLoading)policyDirty=true;};
      contentSurface.Controls.Add(selector);
    }
    foreach(var n in new[]{shortLimit,longLimit}){contentSurface.Controls.Add(n);n.ValueChanged+=(s,e)=>{if(!policyLoading)policyDirty=true;};}
    applyPolicy=MakeButton(contentSurface,"설정 저장",ApplyPolicy);
    tips.SetToolTip(useAccount,"다른 계정으로 전환합니다. 계정 상태를 재확인한 후 진행합니다.");
    tips.SetToolTip(pauseAccount,"자동 계정 선택 대상에서 일시적으로 제외하거나 다시 사용합니다.");
    tips.SetToolTip(autoAccount,"현재 수동으로 고른 계정을 해제하고 자동 선택으로 돌아갑니다.");
    tips.SetToolTip(resetAccount,"초기화권별 만료일과 남은 시간을 먼저 확인합니다. 누르는 것만으로 소비하지 않습니다.");
    tips.SetToolTip(priority,"값이 클수록 자동 선택 순서가 앞섭니다. -100~100");
    tips.SetToolTip(reconcile,"이전 변경 결과가 불확실할 때만 눌러 실제 반영 여부를 확인합니다.");
    tips.SetToolTip(refresh,"한도와 연결 상태를 다시 조회합니다. 서버 요청에는 중복 방지 시간이 있습니다.");
    tips.SetToolTip(more,"갱신 주기 · 상태 복사 · 사용 설명서");
    contentSurface.MouseClick+=ClickAccountCard;
    contentSurface.MouseMove+=MoveAccountCard;
    contentSurface.MouseLeave+=(s,e)=>{if(hoverAccount!=-1){hoverAccount=-1;canvas.Invalidate();}};
    contentSurface.TabStop=true;
    contentSurface.KeyDown+=(s,e)=>{if(compactPage!=0)return;if(e.KeyCode==Keys.Down||e.KeyCode==Keys.Up||e.KeyCode==Keys.Left||e.KeyCode==Keys.Right){int i=SelectedIndex(),step=e.KeyCode==Keys.Down?AccountColumns():e.KeyCode==Keys.Up?-AccountColumns():e.KeyCode==Keys.Right?1:-1;if(accountRows.Count>0)Pick(i<0?0:Math.Max(0,Math.Min(accountRows.Count-1,i+step)));if(SelectedIndex()>=0){int top=P(AccountCell(SelectedIndex()).Top),bottom=top+P(CompactRow),offset=-canvas.AutoScrollPosition.Y;if(top<offset)canvas.AutoScrollPosition=new Point(0,top);else if(bottom>offset+canvas.ClientSize.Height)canvas.AutoScrollPosition=new Point(0,bottom-canvas.ClientSize.Height);}e.Handled=true;}};
    InitializeCreditUI();InitializeOwnerTools();ApplyExpandedAppearance();RenderExpandedState();
  }
  void CreateCoworkPage(){
    var panel=new Panel{BackColor=TrayTheme.Background,Padding=new Padding(P(12))};coworkPage=panel;
    var layout=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,RowCount=6};
    layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
    layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
    layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));
    var help=new Label{AutoSize=true,MaximumSize=new Size(P(520),0),Text="AICC 관리기 아래 코덱스·지피티 관리 대상을 나눕니다. 실행은 현재 도구·권한을 가진 지피티 또는 코덱스가 맡습니다. 기능을 골라 기존 관리 화면을 여세요.",Margin=new Padding(0,0,0,P(8))};
    coworkSearch=new TextBox{Dock=DockStyle.Fill,AccessibleName="명칭과 사용법 찾기",AccessibleDescription="명칭이나 설명의 일부를 입력하면 결과가 줄어듭니다."};
    coworkScope=new ComboBox{Dock=DockStyle.Fill,DropDownStyle=ComboBoxStyle.DropDownList,AccessibleName="안내 적용 범위"};
    coworkScope.Items.AddRange(new object[]{"AICC 관리기 · 전체","[공통] 운영 계약","지피티 관리기","코덱스 관리기"});coworkScope.SelectedIndex=0;
    coworkStatus=new Label{AutoSize=true,Margin=new Padding(0,P(6),0,P(6))};
    coworkText=new RichTextBox{Dock=DockStyle.Fill,ReadOnly=true,DetectUrls=false,BorderStyle=BorderStyle.None,WordWrap=true,ScrollBars=RichTextBoxScrollBars.Vertical,AccessibleName="AI 협업 명칭과 운영 규칙",TabStop=true};
    var actions=new FlowLayoutPanel{Dock=DockStyle.Fill,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,WrapContents=true,Margin=new Padding(0,P(5),0,P(5))};coworkActions=actions;
    MakeButton(actions,"코덱스 CLI",()=>SetCompactPage(9));MakeButton(actions,"대화 관리",()=>SetCompactPage(6));
    var webManager=MakeButton(actions,"웹 관리기 열기",OpenWebManager);webManager.AccessibleDescription="기존 등록된 PC·폰 공용 웹의 AICC 관리기를 엽니다. 지피티 자산 지원과 원 작업 상태를 조회할 수 있습니다. 여는 것만으로 자산을 변경하지 않습니다.";tips.SetToolTip(webManager,webManager.AccessibleDescription);
    layout.Controls.Add(help,0,0);layout.Controls.Add(coworkScope,0,1);layout.Controls.Add(actions,0,2);layout.Controls.Add(coworkSearch,0,3);layout.Controls.Add(coworkStatus,0,4);layout.Controls.Add(coworkText,0,5);
    panel.Controls.Add(layout);Controls.Add(panel);ApplyCoworkAppearance();
    coworkSearch.TextChanged+=(sender,args)=>ReadCoworkGuide();coworkScope.SelectedIndexChanged+=(sender,args)=>ReadCoworkGuide();
    tips.SetToolTip(coworkSearch,"지침, 프로젝트, OCX, 보관 등을 입력하세요. 빈 검색어는 전체를 보여줍니다.");
    tips.SetToolTip(coworkScope,"공통 규칙 또는 각 환경의 안내만 골라봅니다. 원본 내용은 수정하지 않습니다.");
    ReadCoworkGuide();
  }
  void ApplyCoworkAppearance(){
    if(coworkPage==null)return;coworkPage.BackColor=TrayTheme.Background;
    Action<Control> apply=null;apply=parent=>{foreach(Control c in parent.Controls){c.ForeColor=TrayTheme.Text;c.BackColor=TrayTheme.Background;c.Font=body;if(c.HasChildren)apply(c);}};apply(coworkPage);
    coworkSearch.BackColor=coworkScope.BackColor=TrayTheme.Surface;
    // These buttons live in an auto-sized flow row rather than the manually
    // positioned account pages. Size them from the current font at every zoom.
    if(coworkActions!=null)foreach(Control action in coworkActions.Controls){
      var button=action as Button;if(button==null)continue;
      var textSize=TextRenderer.MeasureText(button.Text,button.Font);
      button.AutoSize=false;button.Size=new Size(Math.Max(P(140),textSize.Width+P(28)),Math.Max(P(38),textSize.Height+P(12)));
      button.Margin=new Padding(0,0,P(8),P(6));
    }
  }
  void ReadCoworkGuide(){
    if(coworkText==null)return;
    try{
      string file=System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"public","ai-cowork.json");
      var info=new System.IO.FileInfo(file);if(!info.Exists||info.Length>262144||(info.Attributes&System.IO.FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException();
      var data=new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<Dictionary<string,object>>(System.IO.File.ReadAllText(file,Encoding.UTF8));
      if(Convert.ToInt32(data["schemaVersion"])!=1)throw new InvalidOperationException();
      var scopes=(Dictionary<string,object>)data["scopes"];string query=coworkSearch.Text.Trim(),filter=coworkScope.SelectedIndex==1?"common":coworkScope.SelectedIndex==2?"gpt":coworkScope.SelectedIndex==3?"codex":"";
      var text=new StringBuilder();int count=0;string category="";
      object management;if(data.TryGetValue("management",out management)){
        var manager=(Dictionary<string,object>)management;text.AppendLine(S(manager,"name")).AppendLine(S(manager,"execution")).AppendLine();
        foreach(object child in (System.Collections.IEnumerable)manager["children"]){var item=(Dictionary<string,object>)child;string target=S(item,"scope"),details=S(item,"targets")+" "+S(item,"execution");if(filter!=""&&filter!="common"&&target!=filter||query!=""&&(S(item,"name")+details).IndexOf(query,StringComparison.CurrentCultureIgnoreCase)<0)continue;text.AppendLine("── "+S(item,"name")+" ──").AppendLine("관리 대상: "+S(item,"targets")).AppendLine("실행: "+S(item,"execution")).AppendLine();}
      }
      foreach(string key in new[]{"terms","rules"})foreach(object value in (System.Collections.IEnumerable)data[key]){
        var entry=(Dictionary<string,object>)value;string target=S(entry,"scope"),name=S(entry,"name"),description=S(entry,"description"),group=S(entry,"category");
        if(filter!=""&&target!=filter||query!=""&&(group+" "+name+" "+description).IndexOf(query,StringComparison.CurrentCultureIgnoreCase)<0)continue;
        if(category!=group){category=group;text.AppendLine("── "+category+" ──");}
        text.AppendLine(Convert.ToString(scopes[target])+" "+name).AppendLine(description).AppendLine();count++;
      }
      coworkText.Text=text.ToString();coworkStatus.Text=count+"개 표시 · 개정 "+S(data,"revision")+" · 설치·현재 작동과 별개";
    }catch{coworkStatus.Text="안내를 읽지 못했습니다.";coworkText.Text="설치된 안내 파일 또는 형식을 확인해야 합니다. 기존 계정·실행 설정은 바뀌지 않았습니다. 다른 탭을 이용할 수 있습니다.";}
  }
  void OpenWebManager(){
    try{
      string owner=Environment.GetEnvironmentVariable("AICC_STATE_ROOT");if(String.IsNullOrWhiteSpace(owner))owner=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center");
      string file=System.IO.Path.Combine(owner,"control-plane","mobile-control.json");var info=new System.IO.FileInfo(file);if(!info.Exists||info.Length>65536||(info.Attributes&System.IO.FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException();
      var config=new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<Dictionary<string,object>>(System.IO.File.ReadAllText(file,Encoding.UTF8));Uri uri;
      if(!Uri.TryCreate(S(config,"localUrl"),UriKind.Absolute,out uri)||uri.Scheme!="http"||!uri.IsLoopback||uri.AbsolutePath!="/mobile.html"||uri.Query!=""||uri.Fragment!=""||uri.UserInfo!="")throw new InvalidOperationException();
      System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.AbsoluteUri+"#cowork"){UseShellExecute=true});ShowNotice("기존 AICC 관리기 열기 전달 · 실제 표시는 웹에서 확인하세요");
    }catch{ShowNotice("등록된 웹 관리기를 열지 못했습니다. 도구의 휴대폰 연결에서 기존 주소와 상태를 확인하세요.");}
  }
  void EnsureUtilityPage(int page){
    if(page==10&&coworkPage==null)CreateCoworkPage();
    if(page==9&&cliPage==null){
      string root=AppDomain.CurrentDomain.BaseDirectory;
      cliPage=new AiccCodexCliDialog("ocx",System.IO.Path.Combine(root,"tools","platform","windows","Start-AiccCodexCli.ps1"),System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center","toolchain","pwsh-7.6.6","runtime","pwsh.exe"),System.IO.Path.Combine(root,"docs","user-guide.html"),true);
      Controls.Add(cliPage);cliPage.Show();
    }
    if(page==7&&warningPage==null){
      try{var form=new OcxQuotaWarningDialog(Data,true);warningPage=form;Controls.Add(form);form.Show();}
      catch{warningPage=new Label{Text="경고 설정을 읽지 못했습니다. 기존 설정을 보존했습니다. 설정 파일 형식과 접근 권한을 확인하세요.",ForeColor=TrayTheme.Warning,Padding=new Padding(20)};Controls.Add(warningPage);}
    }
    if(page!=8||settingsPage!=null)return;
    var scroll=new Panel{AutoScroll=true,BackColor=TrayTheme.Background};settingsPage=scroll;Controls.Add(scroll);
    settingsContent=new Panel{BackColor=TrayTheme.Background};scroll.Controls.Add(settingsContent);
    Action<string,bool> note=(text,title)=>{var label=new Label{Text=text,AutoSize=false,ForeColor=title?TrayTheme.Text:TrayTheme.Muted,Tag=title?"title":"note",Font=title?bold:body};settingsContent.Controls.Add(label);settingsRows.Add(new Control[]{label});};
    Func<string,Action,Func<bool>,Button> command=(text,action,selected)=>{var b=MakeButton(settingsContent,text,()=>{action();UpdateSettingsState();});b.AutoSize=false;b.AccessibleDescription=text+". 선택 상태는 강조색과 선택됨 안내로 표시됩니다.";if(selected!=null)settingsSelections[b]=selected;tips.SetToolTip(b,text+" · 선택한 설정을 적용합니다.");return b;};
    note("트레이 설정",true);
    settingsState=new Label{AutoSize=false,ForeColor=TrayTheme.Text,Font=body,Tag="note"};settingsContent.Controls.Add(settingsState);settingsRows.Add(new Control[]{settingsState});
    note("화면 갱신",true);note("열린 창의 캐시 반영 간격입니다. 창이 숨겨지면 수집은 기존 낮은 빈도로 유지됩니다.",false);
    var refreshChoices=new List<Control>();foreach(int seconds in new[]{15,60,0}){int value=seconds;refreshChoices.Add(command(seconds==0?"열 때만":seconds+"초",()=>{if(AutoRefreshRequested!=null)AutoRefreshRequested(value);},()=>RefreshSeconds==value));}settingsRows.Add(refreshChoices.ToArray());
    note("글자 크기",true);var textChoices=new List<Control>();foreach(int percent in new[]{100,110,120}){int value=percent;textChoices.Add(command(percent+"%",()=>SetTextPercent(value),()=>textPercent==value));}settingsRows.Add(textChoices.ToArray());
    note("한도 표시",true);settingsRows.Add(new Control[]{command("사용량",()=>{showRemaining=false;SaveViewPreferences();RenderState();},()=>!showRemaining),command("잔여량",()=>{showRemaining=true;SaveViewPreferences();RenderState();},()=>showRemaining)});
    note("화면과 창",true);settingsRows.Add(new Control[]{command("글래스 효과",()=>SetTransparency(!glassEnabled),()=>glassEnabled),command("창 고정",TogglePin,()=>stayOpen)});
    note("알림과 운영",true);note("일반·긴급 경고의 켜기·끄기, 잔여량 기준과 알림 문구는 사전 경고 탭에서 설정합니다. 저장하면 Codex의 다음 도구 실행 시 반영됩니다.",false);
    settingsRows.Add(new Control[]{command("사전 경고 설정",()=>SetCompactPage(7),null)});
    settingsCopy=command("상태 복사",CopyStatus,null);settingsRows.Add(new Control[]{settingsCopy,command("사용 설명서",()=>{if(GuideRequested!=null)GuideRequested();},null)});
    note("대화 · 재개에서 대화 선택, 메시지 전송, 자동재개와 보류 상태를 함께 관리합니다. 등록·실제 전송·목표 완료는 서로 다릅니다.",false);
    settingsRows.Add(new Control[]{command("AICC 상태 종료",()=>{if(ExitRequested!=null)ExitRequested();},null)});
    scroll.SizeChanged+=(s,e)=>LayoutSettingsPage();UpdateSettingsState();
  }
  void UpdateSettingsState(){
    if(settingsPage==null)return;
    settingsState.Text="갱신: "+(RefreshSeconds==0?"열 때만":RefreshSeconds+"초")+"   ·   글자 "+textPercent+"%   ·   "+(showRemaining?"잔여량":"사용량")+Environment.NewLine+"글래스 "+(glassEnabled?"켜짐":"꺼짐")+"   ·   창 고정 "+(stayOpen?"켜짐":"꺼짐");
    foreach(var choice in settingsSelections){((DarkTrayButton)choice.Key).Primary=choice.Value();choice.Key.AccessibleName=choice.Key.Text+(choice.Value()?" · 선택됨":"");choice.Key.Invalidate();}
    LayoutSettingsPage();
  }
  void LayoutSettingsPage(){
    if(settingsPage==null||settingsContent==null||settingsLayout)return;settingsLayout=true;
    try{
      int width=Math.Max(P(180),settingsPage.ClientSize.Width-SystemInformation.VerticalScrollBarWidth-P(32)),y=P(12);
      settingsContent.SuspendLayout();
      foreach(var row in settingsRows){
        if(row.Length==1&&row[0] is Label){var label=(Label)row[0];label.Font=Convert.ToString(label.Tag)=="title"?bold:body;int height=TextRenderer.MeasureText(label.Text,label.Font,new Size(width,Int32.MaxValue),TextFormatFlags.WordBreak|TextFormatFlags.NoPrefix).Height+P(8);label.SetBounds(P(16),y,width,height);y+=height+P(6);}
        else{int gap=P(8),cell=(width-gap*(row.Length-1))/row.Length,height=Math.Max(P(40),body.Height+P(18));for(int i=0;i<row.Length;i++){row[i].Font=body;row[i].SetBounds(P(16)+i*(cell+gap),y,cell,height);}y+=height+P(12);}
      }
      settingsContent.Size=new Size(width+P(32),y+P(16));settingsContent.ResumeLayout();
    }finally{settingsLayout=false;}
  }
  void SetCompactPage(int page){
    if(page==4)page=6;
    if(page<0||page>10){ShowNotice("실패 · 없는 화면입니다");return;}
    if(compactPage==3&&page!=3)ClearCreditInventory();
    compactPage=page;
    if(page==6&&conversationPanel==null){
      conversationPanel=new CodexConversationHost(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"tools","platform","windows","Invoke-AiccCodexContinuity.ps1"),key=>{if(ToolRequested!=null)ToolRequested(key);else ShowNotice("기존 관리 연결을 확인하세요");}){Font=body,Visible=false};
      Controls.Add(conversationPanel);
    }
    EnsureUtilityPage(page);
    if(conversationPanel!=null)conversationPanel.Visible=page==6;
    if(warningPage!=null)warningPage.Visible=page==7;if(settingsPage!=null)settingsPage.Visible=page==8;
    if(cliPage!=null)cliPage.Visible=page==9;
    if(coworkPage!=null)coworkPage.Visible=page==10;
    if(page==8)UpdateSettingsState();
    canvas.Visible=page!=6&&page!=7&&page!=8&&page!=9&&page!=10;
    if(page==2&&!policyDirty)ReadPolicy();
    canvas.AutoScrollPosition=Point.Empty;
    RenderExpandedState();
    RefreshTaskSummary(false);
  }
  void SelectExpandedPage(int page){SetCompactPage(page);}
  internal void SelectPreviewPage(int page){if(compactReady)SetCompactPage(page);}
  internal void OpenCliPage(string route){SetCompactPage(9);cliPage.SelectRoute(route);if(!Visible)Toggle();Activate();}
  internal void StressNavigation(int iterations){
    for(int i=0;i<iterations;i++){
      SetCompactPage(i%3);
      if(accountRows.Count>0)Pick(i%accountRows.Count);
      Application.DoEvents();
      if(IsDisposed)throw new InvalidOperationException("Navigation closed tray");
    }
    SetCompactPage(0);
  }
  // Only the explicit off-screen preview invokes this. All callbacks are fake.
  internal void ExerciseUi(string evidencePath){
    int checks=0,dispatches=0;
    Action<bool,string> require=(ok,label)=>{if(!ok)throw new InvalidOperationException("UI contract: "+label);checks++;};
    var saved=new Dictionary<string,object>(Data);
    var row=new Dictionary<string,object>{{"name","미리보기 계정"},{"selector","fixture"},{"identityHash",new string('a',64)},{"displayNameVerified",true},{"active",false},{"paused",false},{"priority",0},{"status","대기"}};
    Data["accounts"]=new object[]{row};
    Data["controlNeedsReconcile"]=false;
    Data["effectivePolicy"]=new Dictionary<string,object>{{"settingsSupported",true},{"fiveHourUsedThreshold",95},{"longWindowUsedThreshold",98},{"fiveHourAction","switch"},{"longWindowAction","stop"}};
    Data["collectorError"]=false;Data["quotaReadFailed"]=false;
    Data["observedAt"]=DateTime.UtcNow.ToString("o");Data["quotaObservedAt"]=DateTime.UtcNow.AddMinutes(-3).ToString("o");Data["quotaOldestObservedAt"]=Data["quotaObservedAt"];
    RenderState();DateTime stamp=lastQuotaUtc;
    AccountActionRequested=(account,action,value)=>{require(S(account,"identityHash","")==new string('a',64),"exact identity");dispatches++;BeginChange();};
    foreach(string action in new[]{"use","pause","resume","unpin","priority","reset"}){
      foreach(string outcome in new[]{"PASS","FAIL","UNCERTAIN","CANCELLED","NOOP"}){
        Loading=false;ControlsLocked=false;row["active"]=false;row["paused"]=action=="resume";SetCompactPage(0);RenderState();
        int before=dispatches;RunSelected(action,action=="priority"?(int?)1:null);
        require(dispatches==before+1&&Loading,action+" accepted");
        RunSelected(action,action=="priority"?(int?)1:null);
        require(dispatches==before+1&&notice.Contains("중복"),action+" duplicate suppressed");
        CompleteChange(new Dictionary<string,object>{{"terminal",outcome}});
        require(!Loading&&ControlsLocked==(outcome=="UNCERTAIN"),action+" completion lock");
        require(notice.Contains(outcome=="PASS"?"성공":outcome=="FAIL"?"실패":outcome=="UNCERTAIN"?"불확실":outcome=="CANCELLED"?"취소":"변경없음"),action+" result label");
        require(lastQuotaUtc==stamp,action+" preserves quota time");
      }
    }
    ControlsLocked=false;Loading=false;int count=dispatches;row["active"]=true;RunSelected("use",null);
    RunSelected("priority",0);require(dispatches==count&&notice.Contains("변경없음"),"no-op does not dispatch");
    CompleteChange(null);require(ControlsLocked&&notice.Contains("불확실"),"timeout locks");
    count=dispatches;RunSelected("reset",null);require(dispatches==count,"uncertain blocks future mutation");
    CompleteChange(new Dictionary<string,object>{{"terminal","UNCERTAIN"},{"resetCode","reset"}});
    require(notice.Contains("불확실"),"reset code cannot hide uncertainty");
    CompleteChange(new Dictionary<string,object>{{"terminal","PASS"},{"localMetadataSynced",false}});
    require(ControlsLocked&&notice.Contains("로컬"),"local reconciliation pending");
    ControlsLocked=false;
    foreach(string code in new[]{"reset","already_redeemed","nothing_to_reset","no_credit"}){
      CompleteChange(new Dictionary<string,object>{{"terminal","PASS"},{"resetCode",code}});
      require(notice.Contains(code=="reset"?"성공":"변경없음"),"reset "+code);
    }
    CompleteChange(new Dictionary<string,object>{{"terminal","FAIL"},{"mutationDispatched",true}});
    require(ControlsLocked&&notice.Contains("불확실"),"dispatched failure remains fenced");
    ControlsLocked=false;Loading=false;
    AcceptSnapshot(new Dictionary<string,object>{{"quotaReadFailed",true},{"accounts",new object[0]},{"quotaObservedAt",DateTime.UtcNow.AddMinutes(-10).ToString("o")},{"observedAt",DateTime.UtcNow.ToString("o")}});
    RenderState();require(accountRows.Count==1&&S(accountRows[0],"status")=="확인 필요"&&lastQuotaUtc==stamp,"failed snapshot retains rows and latest quota time");
    Data=new Dictionary<string,object>(saved);Data["accounts"]=new object[]{row};RenderState();
    int policyCalls=0;PolicyActionRequested=request=>{policyCalls++;BeginChange();};
    SetCompactPage(2);applyPolicy.PerformClick();require(policyCalls==0&&notice.Contains("변경없음"),"policy unchanged");
    shortLimit.Value=94;applyPolicy.PerformClick();require(policyCalls==1&&Loading,"policy click dispatch");
    ApplyPolicy();require(policyCalls==1,"policy duplicate");
    CompleteChange(new Dictionary<string,object>{{"terminal","CANCELLED"}});
    require(notice.Contains("취소"),"policy cancelled");
    object policyObject;var accountPolicy=Data.TryGetValue("effectivePolicy",out policyObject)?policyObject as Dictionary<string,object>:null;
    if(accountPolicy!=null)accountPolicy["accountQuotaProtectionSupported"]=true;
    row["quotaProtectionEnabled"]=false;Loading=false;ControlsLocked=false;
    Dictionary<string,object> quotaRequest=null;PolicyActionRequested=request=>{quotaRequest=request;BeginChange();};
    using(var accountMenu=AccountMenu(row)){
      ToolStripItem toggle=null;foreach(ToolStripItem item in accountMenu.Items)if(item.Text.StartsWith("한도 사전 차단:"))toggle=item;
      require(toggle!=null&&toggle.Enabled&&toggle.Text.Contains("꺼짐"),"account quota current state");
      toggle.PerformClick();require(quotaRequest!=null&&S(quotaRequest,"action")=="quota-protection"&&Flag(quotaRequest,"enabled")&&S(quotaRequest,"identityHash")==new string('a',64),"account quota exact toggle");
      quotaRequest=null;toggle.PerformClick();require(quotaRequest==null,"account quota duplicate suppressed");
    }
    CompleteChange(new Dictionary<string,object>{{"terminal","PASS"}});
    for(int i=0;i<tabs.Count;i++){tabs[i].PerformClick();require(compactPage==tabPages[i],"tab click "+i);}
    int guides=0,slacks=0;GuideRequested=()=>{guides++;ShowNotice("설명서 열기 전달 완료 · 실제 표시 미확인");};SlackRequested=()=>{slacks++;ShowNotice("Slack 열기 전달 완료 · 실제 표시 미확인");};
    SetCompactPage(1);guide.PerformClick();slack.PerformClick();require(guides==1&&slacks==1,"guide and Slack callbacks");
    int refreshes=0;RefreshRequested=()=>{refreshes++;RefreshPending=true;ShowNotice("조회 대기");RenderState();};
    refresh.PerformClick();refresh.PerformClick();require(refreshes==1&&!refresh.Enabled,"refresh duplicate");
    Data["quotaReadFailed"]=true;RefreshPending=false;RenderState();require(lastQuotaUtc==stamp&&LastCollectorText().Contains("조회실패"),"failed read preserves stamp");
    Data["quotaReadFailed"]=false;Data["collectorError"]=false;Data["quotaOldestObservedAt"]=DateTime.UtcNow.AddMinutes(-3).ToString("o");RenderState();require(LastCollectorText().Contains("오래됨"),"oldest quota stale: "+LastCollectorText());
    SetCompactPage(8);string copied="";StatusCopyWriter=text=>copied=text;settingsCopy.PerformClick();
    require(copied.Contains("최근 한도")&&copied.Contains("수집")&&notice.Contains("복사"),"copy click with fake clipboard");
    StatusCopyWriter=text=>{throw new System.Runtime.InteropServices.ExternalException();};settingsCopy.PerformClick();
    require(notice.Contains("클립보드"),"copy failure feedback");StatusCopyWriter=Clipboard.SetText;
    SetCompactPage(0);
    ResetCreditsRequested=(account,id)=>{ReceiveCreditInventory(new Dictionary<string,object>{{"terminal","PASS"},{"identityHash",S(account,"identityHash")},{"requestId",id},{"availableCount",1},{"observedAt",DateTime.UtcNow.ToString("o")},{"credits",new object[]{new Dictionary<string,object>{{"expiresAt",DateTime.UtcNow.AddHours(1).ToString("o")}}}}});};
    resetAccount.PerformClick();require(compactPage==3&&creditVerified,"credit inventory click");
    selectedCredit=0;CreditControls();count=dispatches;creditUse.PerformClick();
    require(dispatches==count&&confirmCredit==0,"credit first click confirmation only");
    creditUse.PerformClick();require(dispatches==count+1&&Loading,"credit confirmed once");
    CompleteChange(new Dictionary<string,object>{{"terminal","PASS"},{"resetCode","nothing_to_reset"}});
    require(notice.Contains("변경없음"),"credit no-op result");
    creditBack.PerformClick();require(compactPage==0&&!creditVerified,"credit back invalidates");
    StressNavigation(120);StressMenuLifecycle(120);StressTransparency(100);checks+=3;
    Data=saved;Loading=false;ControlsLocked=false;RefreshPending=false;RenderState();SelectPreviewPage(0);
    System.IO.File.WriteAllText(evidencePath,new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(new Dictionary<string,object>{{"terminal","PASS"},{"checks",checks},{"fakeDispatches",dispatches},{"realAccountMutations",0},{"offscreen",true},{"fakeClipboardTested",true}}));
  }
  int SelectedIndex(){
    for(int i=0;i<accountRows.Count;i++)
      if(S(accountRows[i],"identityHash","")==pickedAccount&&pickedAccount.Length==64)return i;
    return -1;
  }
  Dictionary<string,object> Selected(){int i=SelectedIndex();return i>=0?accountRows[i]:null;}
  void Pick(int i){
    if(i<0||i>=accountRows.Count)return;
    pickedAccount=S(accountRows[i],"identityHash","");ClearCreditInventory();contentSurface.AccessibleName="계정 목록 · "+AccountLabel(accountRows[i])+" 선택됨 · 위아래 방향키로 이동";
    UpdateSelectedControls();
    canvas.Invalidate();
  }
  void ClickAccountCard(object sender,MouseEventArgs e){if(e.Button!=MouseButtons.Left)return;if(compactPage==3){ChooseCredit(e.Location);return;}if(compactPage!=0)return;int i=AccountAt(e.Location);if(i>=0){Pick(i);contentSurface.Focus();}}
  void MoveAccountCard(object sender,MouseEventArgs e){
    if(compactPage==3){contentSurface.Cursor=CreditAt(e.Location)>=0?Cursors.Hand:Cursors.Default;return;}if(compactPage!=0)return;int next=AccountAt(e.Location);
    contentSurface.Cursor=next>=0?Cursors.Hand:Cursors.Default;
    if(next!=hoverAccount){int previous=hoverAccount;hoverAccount=next;InvalidateAccountCell(previous);InvalidateAccountCell(next);}
  }
  int LogicalContentWidth(){return Math.Max(1,(int)Math.Floor(contentSurface.ClientSize.Width/Math.Max(0.1f,scale)));}
  int AccountColumns(){return ClientSize.Width>=P(520)?2:1;}
  int DetailOffset(){return Math.Max(0,(LogicalContentWidth()-(compactPage==2?PolicyWidth():392))/2);}
  Rectangle AccountCell(int index){
    int columns=AccountColumns(),width=Math.Max(1,(LogicalContentWidth()-24-(columns-1)*12)/columns);
    return new Rectangle(12+(index%columns)*(width+12),CompactCardTop+(index/columns)*CompactRow,width,CompactRow-6);
  }
  void InvalidateAccountCell(int index){
    if(index<0||index>=accountRows.Count)return;
    var r=AccountCell(index);contentSurface.Invalidate(new Rectangle(P(r.X-2),P(r.Y-2),P(r.Width+4),P(r.Height+4)));
  }
  int AccountAt(Point p){
    var logical=new Point((int)(p.X/Math.Max(0.1f,scale)),(int)(p.Y/Math.Max(0.1f,scale)));
    for(int i=0;i<accountRows.Count;i++)if(AccountCell(i).Contains(logical))return i;
    return -1;
  }
  int OrderRowHeight(){return (int)Math.Ceiling(36*textPercent/100f);}
  int OrderListHeight(){return Math.Max(OrderRowHeight()*2,accountRows.Count*OrderRowHeight());}
  int PolicySectionTop(){return OrderListHeight()+196;}
  int PolicyWidth(){return Math.Max(280,Math.Min(552,LogicalContentWidth()-32));}
  string OrderIds(List<Dictionary<string,object>> rows){
    var ids=new List<string>();foreach(var row in rows)ids.Add(S(row,"identityHash",""));
    return String.Join("|",ids.ToArray());
  }
  void MoveAccountOrder(int step){
    if(Loading||ControlsLocked||B("controlNeedsReconcile")||orderConflict)return;
    int from=orderedAccounts.FindIndex(r=>S(r,"identityHash","")==pickedAccount),to=from+step;
    if(from<0||to<0||to>=orderedAccounts.Count)return;
    var row=orderedAccounts[from];orderedAccounts.RemoveAt(from);orderedAccounts.Insert(to,row);
    orderDirty=OrderIds(orderedAccounts)!=orderBaselineIds;
    UpdateSelectedControls();canvas.Invalidate();
    ShowNotice(AccountLabel(row)+" · "+(to+1)+"번째로 이동 · 순서 저장을 누르면 적용됩니다.");
  }
  void SaveAccountOrder(){
    if(!orderDirty||orderConflict||Loading||ControlsLocked||B("controlNeedsReconcile")||OrderActionRequested==null)return;
    var entries=new List<Dictionary<string,object>>();
    foreach(var row in orderedAccounts){
      if(!Flag(row,"displayNameVerified")||S(row,"identityHash","").Length!=64){ShowNotice("계정 신원을 먼저 확인하세요.");return;}
      entries.Add(new Dictionary<string,object>{{"selector",S(row,"selector","")},{"identityHash",S(row,"identityHash","")}});
    }
    orderSaving=true;
    ShowNotice("사용 순서 저장 중 · 현재 사용 계정은 유지합니다.");
    OrderActionRequested(new Dictionary<string,object>{{"action","order"},{"order",entries.ToArray()}});
  }
  void DrawOrderItem(object sender,DrawItemEventArgs e){
    if(e.Index<0||e.Index>=routeOrder.Items.Count)return;
    bool selected=(e.State&DrawItemState.Selected)!=0;
    Color fill=SystemInformation.HighContrast?(selected?SystemColors.Highlight:SystemColors.Window):
      selected?TrayTheme.Blend(TrayTheme.Surface,TrayTheme.Accent,0.16f):TrayTheme.Surface;
    Color ink=SystemInformation.HighContrast?(selected?SystemColors.HighlightText:SystemColors.WindowText):TrayTheme.Text;
    using(var brush=new SolidBrush(fill))e.Graphics.FillRectangle(brush,e.Bounds);
    if(selected)using(var brush=new SolidBrush(TrayTheme.Accent))e.Graphics.FillRectangle(brush,e.Bounds.X,e.Bounds.Y+P(5),P(3),e.Bounds.Height-P(10));
    TextRenderer.DrawText(e.Graphics,Convert.ToString(routeOrder.Items[e.Index]),body,
      new Rectangle(e.Bounds.X+P(12),e.Bounds.Y,e.Bounds.Width-P(24),e.Bounds.Height),ink,
      TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix|TextFormatFlags.PreserveGraphicsClipping);
    if((e.State&DrawItemState.Focus)!=0)e.DrawFocusRectangle();
  }
  void UpdateAccountSelectors(){
    if(accountPicker==null||routeOrder==null)return;
    selectingAccount=true;
    try{
      var sorted=new List<Dictionary<string,object>>(accountRows);
      sorted.Sort((a,b)=>{int n=Priority(b).CompareTo(Priority(a));return n!=0?n:String.Compare(S(a,"name"),S(b,"name"),StringComparison.CurrentCulture);});
      var stamps=new List<string>();foreach(var row in sorted)stamps.Add(S(row,"identityHash","")+":"+Priority(row));
      string baseline=String.Join("|",stamps.ToArray());
      if(!orderDirty){
        orderedAccounts.Clear();orderedAccounts.AddRange(sorted);
        orderBaseline=baseline;orderBaselineIds=OrderIds(sorted);orderConflict=false;
      }else{
        if(baseline!=orderBaseline)orderConflict=true;
        for(int i=0;i<orderedAccounts.Count;i++){
          string identity=S(orderedAccounts[i],"identityHash","");
          var current=accountRows.Find(r=>S(r,"identityHash","")==identity);
          if(current!=null)orderedAccounts[i]=current;else orderConflict=true;
        }
      }
      var pickerText=new List<string>();var orderText=new List<string>();
      foreach(var row in accountRows)pickerText.Add(AccountLabel(row)+(Flag(row,"active")?" · 사용 중":""));
      int rank=0;foreach(var row in orderedAccounts)orderText.Add((++rank)+"순위   "+AccountLabel(row)+(Flag(row,"paused")?" · 제외":Flag(row,"active")?" · 사용 중":""));
      string nextPicker=String.Join("\n",pickerText.ToArray()),nextOrder=String.Join("\n",orderText.ToArray());
      if(nextPicker!=pickerSignature&&!accountPicker.DroppedDown){
        accountPicker.BeginUpdate();try{accountPicker.Items.Clear();accountPicker.Items.AddRange(pickerText.ToArray());pickerSignature=nextPicker;}finally{accountPicker.EndUpdate();}
      }
      if(nextOrder!=orderSignature){
        routeOrder.BeginUpdate();try{routeOrder.Items.Clear();routeOrder.Items.AddRange(orderText.ToArray());orderSignature=nextOrder;}finally{routeOrder.EndUpdate();}
      }
      if(!accountPicker.DroppedDown)accountPicker.SelectedIndex=SelectedIndex();
      routeOrder.SelectedIndex=orderedAccounts.FindIndex(r=>S(r,"identityHash","")==pickedAccount);
    }finally{selectingAccount=false;}
  }
  void RunSelected(string action,int? value){
    var row=Selected();if(row==null){ShowNotice("실패 · 선택한 계정이 없습니다");return;}
    if(S(row,"identityHash","").Length!=64||!Flag(row,"displayNameVerified")){ShowNotice("실패 · 계정 신원 확인 필요");return;}
    RequestAccount(row,action,value);
  }
  bool PolicySupported(){
    object p;var row=Data.TryGetValue("effectivePolicy",out p)?p as Dictionary<string,object>:null;
    return row!=null&&Flag(row,"settingsSupported");
  }
  void ReadPolicy(){
    object p;var row=Data.TryGetValue("effectivePolicy",out p)?p as Dictionary<string,object>:null;
    if(row==null)return;policyLoading=true;
    try{
      int n;if(Int32.TryParse(S(row,"fiveHourUsedThreshold"),out n))shortLimit.Value=Math.Max(1,Math.Min(100,n));
      if(Int32.TryParse(S(row,"longWindowUsedThreshold"),out n))longLimit.Value=Math.Max(1,Math.Min(100,n));
      shortRule.SelectedIndex=S(row,"fiveHourAction")=="stop"?1:0;
      longRule.SelectedIndex=S(row,"longWindowAction")=="stop"?1:0;
      policyDirty=false;
    }finally{policyLoading=false;}
  }
  void ApplyPolicy(){
    if(Loading){ShowNotice("중복 정책 요청 억제 · 변경 진행 중");return;}
    if(!PolicySupported()||ControlsLocked||B("controlNeedsReconcile")||PolicyActionRequested==null){ShowNotice("실패 · 정책 변경 불가 · 연결/반영 확인 필요");return;}
    object existing;var current=Data.TryGetValue("effectivePolicy",out existing)?existing as Dictionary<string,object>:null;
    if(current!=null&&(int)shortLimit.Value==Convert.ToInt32(current["fiveHourUsedThreshold"])&&(int)longLimit.Value==Convert.ToInt32(current["longWindowUsedThreshold"])&&
       S(current,"fiveHourAction")==(shortRule.SelectedIndex==1?"stop":"switch")&&S(current,"longWindowAction")==(longRule.SelectedIndex==1?"stop":"switch")){
      policyDirty=false;ShowNotice("변경없음 · 현재 한도 정책과 같습니다");return;
    }
    ShowNotice("한도 정책 적용 요청");
    PolicyActionRequested(new Dictionary<string,object>{{"action","policy"},{"shortThreshold",(int)shortLimit.Value},{"longThreshold",(int)longLimit.Value},{"shortAction",shortRule.SelectedIndex==1?"stop":"switch"},{"longAction",longRule.SelectedIndex==1?"stop":"switch"}});
    policyDirty=false;
  }
  void DrawRuleItem(object sender,DrawItemEventArgs e){
    var selector=sender as ComboBox;if(selector==null||e.Index<0||e.Index>=selector.Items.Count)return;
    using(var b=new SolidBrush(TrayTheme.Surface))e.Graphics.FillRectangle(b,e.Bounds);
    TextRenderer.DrawText(e.Graphics,Convert.ToString(selector.Items[e.Index]),body,new Rectangle(e.Bounds.X+4,e.Bounds.Y,e.Bounds.Width-7,e.Bounds.Height),selector.Enabled?TrayTheme.Text:TrayTheme.Muted,TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix|TextFormatFlags.PreserveGraphicsClipping);
  }
  void RenderExpandedState(){
    RememberObservation();UpdateFooterFeedback();
    quotaStamp.Font=collectorStamp.Font=small;quotaStamp.ForeColor=collectorStamp.ForeColor=TrayTheme.Muted;quotaStamp.BackColor=collectorStamp.BackColor=TrayTheme.Surface;
    tips.SetToolTip(quotaStamp,LastQuotaText()+Environment.NewLine+LastCollectorText());
    object obj;var enumerable=Data.TryGetValue("accounts",out obj)?obj as System.Collections.IEnumerable:null;
    var rows=new List<Dictionary<string,object>>();
    if(enumerable!=null)foreach(object value in enumerable){var row=value as Dictionary<string,object>;if(row!=null)rows.Add(row);}
    // Display order is stable; changing route or priority must not move the user's target.
    rows.Sort((a,b)=>String.Compare(S(a,"name"),S(b,"name"),StringComparison.CurrentCulture));    accountRows.Clear();accountRows.AddRange(rows);
    if(SelectedIndex()<0){
      int current=accountRows.FindIndex(r=>Flag(r,"active"));
      pickedAccount=accountRows.Count>0?S(accountRows[current>=0?current:0],"identityHash",""):"";
    }
    if(compactPage==2&&!policyDirty)ReadPolicy();
    bool accountsVisible=compactPage==0,policyVisible=compactPage==2,editable=PolicySupported();
    accountActions.Visible=accountsVisible||policyVisible;
    useAccount.Visible=accountMore.Visible=accountsVisible||policyVisible;
    resetAccount.Visible=accountsVisible;
    autoAccount.Visible=policyVisible;
    pauseAccount.Visible=accountsVisible||policyVisible;loginAccount.Visible=false;
    copyStatus.Visible=collectorStamp.Visible=false;
    priority.Visible=false;
    applyPriority.Visible=routeOrder.Visible=priorityFirst.Visible=priorityLast.Visible=orderReset.Visible=orderFeedback.Visible=policyVisible;
    accountPicker.Visible=accountsVisible;
    UpdateAccountSelectors();
    foreach(var c in new Control[]{shortLimit,longLimit,shortRule,longRule,applyPolicy}){c.Visible=policyVisible&&editable;c.Enabled=policyVisible&&editable&&!Loading&&!ControlsLocked&&!B("controlNeedsReconcile");}
    slack.Visible=guide.Visible=compactPage==1;
    if(queueGuide!=null){queueGuide.Visible=compactPage==1;queueGuide.SetBounds(P(DetailOffset()+242),P(313),P(125),P(28));}
    refresh.Text=Loading?"변경 중":RefreshPending?"조회 대기":"새로 고침";refresh.Enabled=!Loading&&!RefreshPending;
    more.Enabled=!Loading;
    reconcile.Visible=ControlsLocked||B("controlNeedsReconcile");reconcile.Enabled=!Loading&&reconcile.Visible;
    for(int i=0;i<tabs.Count;i++){((DarkTrayButton)tabs[i]).Navigation=true;((DarkTrayButton)tabs[i]).Primary=compactPage==tabPages[i]||(compactPage==3&&i==0);tabs[i].Invalidate();}
    UpdateSelectedControls();
    CreditControls();
    UpdateOwnerTools();
    if(laidOutPage!=compactPage||laidOutRows!=accountRows.Count)LayoutExpandedDpi();
    if(compactPage==8)UpdateSettingsState();
    canvas.Invalidate();
  }
  void OpenSelectedLogin(){
    var row=Selected();
    if(row==null||!Flag(row,"displayNameVerified")||S(row,"identityHash","").Length!=64){ShowNotice("계정 신원 확인이 필요합니다");return;}
    if(Loading||ControlsLocked||B("controlNeedsReconcile")){ShowNotice("진행 중인 변경 결과를 먼저 확인하세요");return;}
    if(DashboardRequested==null){ShowNotice("OCX 관리 화면 연결이 없습니다");return;}
    Data["loginTargetName"]=AccountLabel(row);
    DashboardRequested();
  }
  void UpdateFooterFeedback(){
    string message=Loading?"변경 처리 중 · 잠시 기다려 주세요":RefreshPending?"최신 사용량 조회 중":
      DateTime.UtcNow<noticeUntil?notice:lastQuotaReadFailed?"조회 지연 · "+LastQuotaText():LastQuotaText();
    if(quotaStamp.Text!=message)quotaStamp.Text=message;
  }
  internal void TickFeedback(){
    if(!compactReady||!Visible)return;
    if(compactPage==6&&conversationPanel!=null)conversationPanel.TickQueueFeedback();
    UpdateFooterFeedback();
    if(compactPage==3)CreditControls();
  }
  void UpdateSelectedControls(){
    if(!compactReady)return;
    var row=Selected();
    var activeRow=accountRows.Find(r=>Flag(r,"active"));
    selectedAccountCaption.Text=S(row,"identityHash","")==S(activeRow,"identityHash","")?"사용 중 · "+AccountLabel(activeRow):"선택 "+AccountLabel(row)+"   ·   사용 중 "+AccountLabel(activeRow);
    object protection;
    selectedAccountCaption.Text+=" · 사전 차단 "+(row!=null&&row.TryGetValue("quotaProtectionEnabled",out protection)&&protection is bool?((bool)protection?"켜짐":"꺼짐"):"미확인");
    UpdateAccountSelectors();
    bool blocked=Loading||ControlsLocked||B("controlNeedsReconcile")||row==null;
    accountPicker.Enabled=!blocked;
    routeOrder.Enabled=!Loading&&!ControlsLocked&&!B("controlNeedsReconcile");
    priorityFirst.Enabled=priorityLast.Enabled=applyPriority.Enabled=false;
    orderReset.Enabled=!blocked&&(orderDirty||orderConflict);
    orderFeedback.Font=small;orderFeedback.ForeColor=orderConflict?TrayTheme.Warning:orderDirty?TrayTheme.Accent:TrayTheme.Muted;
    orderFeedback.Text=orderSaving?"사용 순서를 저장하고 있습니다…":orderConflict?"다른 곳에서 순서가 바뀌었습니다. 되돌리기로 다시 불러오세요.":
      orderDirty?"저장하면 적용됩니다.":"수동 선택이 이 순서보다 우선합니다.";
    loginAccount.Enabled=accountMore.Enabled=!blocked&&row!=null&&Flag(row,"displayNameVerified")&&S(row,"identityHash","").Length==64;
    if(row==null){useAccount.Enabled=pauseAccount.Enabled=autoAccount.Enabled=resetAccount.Enabled=priority.Enabled=applyPriority.Enabled=false;return;}
    bool active=Flag(row,"active"),paused=Flag(row,"paused"),identity=Flag(row,"displayNameVerified")&&S(row,"identityHash","").Length==64;
    string status=S(row,"status");
    useAccount.Text=active?"사용 중":"사용";
    useAccount.Enabled=!blocked&&identity&&!active&&!paused&&!new[]{"한도 차단","로그인 필요","확인 필요","선택 미확인","조회 재시도","인증 확인 중"}.ContainsStatus(status);
    ((DarkTrayButton)useAccount).Primary=useAccount.Enabled;
    pauseAccount.Text=paused?"사용 재개":"사용 중지";
    pauseAccount.AccessibleName=AccountLabel(row)+" · "+pauseAccount.Text;
    tips.SetToolTip(pauseAccount,paused?"이 계정을 새 요청의 자동 선택에 다시 포함합니다.":"이 계정을 새 요청의 자동 선택에서 제외합니다. 진행 중인 요청을 강제로 취소하지 않습니다.");
    pauseAccount.Enabled=!blocked&&identity;
    autoAccount.Enabled=!blocked&&activeRow!=null&&Flag(activeRow,"displayNameVerified");
    resetAccount.Text="초기화권";resetAccount.Enabled=!blocked&&identity;
    ((DarkTrayButton)resetAccount).Primary=false;((DarkTrayButton)loginAccount).Primary=Flag(row,"needsReauth");
    priority.Enabled=!blocked&&identity;
    if(!priority.Focused&&!selectingAccount){
      selectingAccount=true;
      try{var number=Math.Max(-100,Math.Min(100,Priority(row)));if(priority.Value!=number)priority.Value=number;}
      finally{selectingAccount=false;}
    }
    int orderIndex=orderedAccounts.FindIndex(r=>S(r,"identityHash","")==pickedAccount);
    priorityFirst.Enabled=!blocked&&identity&&!orderConflict&&orderIndex>0;
    priorityLast.Enabled=!blocked&&identity&&!orderConflict&&orderIndex>=0&&orderIndex<orderedAccounts.Count-1;
    applyPriority.Enabled=!blocked&&identity&&orderDirty&&!orderConflict;
    ((DarkTrayButton)applyPriority).Primary=applyPriority.Enabled;
  }
  void LayoutExpandedDpi(){
    using(var g=CreateGraphics())scale=g.DpiX/96;
    var area=PopupWorkArea();
    int chrome=Height-ClientSize.Height;
    int wantedWidth=Math.Min(P(CompactWidth),Math.Max(1,area.Width-(Width-ClientSize.Width)-P(16)));
    int expectedColumns=wantedWidth>=P(520)?2:1;
    int expectedLines=Math.Max(1,(accountRows.Count+expectedColumns-1)/expectedColumns);
    int desiredContent=compactPage==0?CompactCardTop+expectedLines*CompactRow+64:compactPage==1?506:compactPage==3?CreditPageHeight():compactPage==6?510:compactPage>=7?560:compactPage>=4?OwnerToolsHeight():PolicySectionTop()+238;
    int desiredActions=compactPage==0?78:compactPage==2?74:0;
    int connectionNav=44*((tabs.Count+Math.Max(3,Math.Min(4,((int)(wantedWidth/scale)-48)/118))-1)/Math.Max(3,Math.Min(4,((int)(wantedWidth/scale)-48)/118)));
    int wantedHeight=Math.Min(P(Math.Min(compactPage==1?760:680,desiredContent+(compactPage==1?connectionNav:44)+CompactFooter+desiredActions)),Math.Max(1,area.Height-chrome-P(16)));
    if(ClientSize.Width!=wantedWidth||ClientSize.Height!=wantedHeight)ClientSize=new Size(wantedWidth,wantedHeight);
    int columns=AccountColumns(),accountLines=Math.Max(1,(accountRows.Count+columns-1)/columns);
    int content=compactPage==0?CompactCardTop+accountLines*CompactRow+64:compactPage==1?506:compactPage==3?CreditPageHeight():compactPage==6?510:compactPage>=7?560:compactPage>=4?OwnerToolsHeight():PolicySectionTop()+238;
    int columnsInNav=Math.Max(3,Math.Min(4,((int)(ClientSize.Width/scale)-48)/118));
    int navHeight=P(44*((tabs.Count+columnsInNav-1)/columnsInNav)),footHeight=P(compactPage==6?40:CompactFooter),actionHeight=P(desiredActions);
    navigation.SetBounds(0,0,ClientSize.Width,navHeight);
    footer.SetBounds(0,ClientSize.Height-footHeight,ClientSize.Width,footHeight);
    accountActions.SetBounds(0,footer.Top-actionHeight,ClientSize.Width,actionHeight);
    canvas.SetBounds(0,navHeight,ClientSize.Width,Math.Max(1,footer.Top-actionHeight-navHeight));
    var extent=new Size(0,P(content));
    if(canvas.AutoScrollMinSize!=extent)canvas.AutoScrollMinSize=extent;
    contentSurface.Size=new Size(Math.Max(1,canvas.ClientSize.Width),P(content));
    int width=(int)(ClientSize.Width/scale),tabWidth=Math.Max(70,(width-48)/columnsInNav);
    for(int i=0;i<tabs.Count;i++)tabs[i].SetBounds(P(8+(i%columnsInNav)*tabWidth),P(3+(i/columnsInNav)*44),P(tabWidth-4),P(38));
    pin.SetBounds(P(width-40),P(7),P(28),P(28));
    refresh.SetBounds(P(12),P(7),P(110),P(30));
    reconcile.SetBounds(P(132),P(7),P(116),P(30));
    more.SetBounds(P(width-84),P(7),P(72),P(30));
    quotaStamp.SetBounds(P(12),P(40),P(width-24),P(19));quotaStamp.AutoEllipsis=true;
    int pickerWidth=(width-32)/2;
    accountPicker.SetBounds(P(12),P(7),P(pickerWidth),P(28));
    selectedAccountCaption.Visible=compactPage==2;
    accountPicker.SetBounds(P(12),P(6),P(width-24),P(28));
    int useWidth=(width-48)/4,creditWidth=useWidth,moreWidth=width-48-useWidth*3;
    if(compactPage==2){
      selectedAccountCaption.SetBounds(P(12),P(5),P(width-24),P(24));
    }
    int actionY=compactPage==2?32:39;
    useAccount.SetBounds(P(12),P(actionY),P(useWidth),P(33));
    pauseAccount.SetBounds(P(20+useWidth),P(actionY),P(useWidth),P(33));
    resetAccount.SetBounds(P(28+useWidth*2),P(actionY),P(creditWidth),P(33));
    autoAccount.SetBounds(P(28+useWidth*2),P(actionY),P(creditWidth),P(33));
    accountMore.SetBounds(P(36+useWidth*2+creditWidth),P(actionY),P(moreWidth),P(33));
    int offset=DetailOffset();
    slack.SetBounds(P(offset+12),P(462),P(178),P(32));
    guide.SetBounds(P(offset+202),P(462),P(178),P(32));
    int detailWidth=PolicyWidth(),inner=detailWidth-24,orderHeight=OrderListHeight(),orderButtons=86+orderHeight,policyTop=PolicySectionTop();
    routeOrder.ItemHeight=Math.Max(P(OrderRowHeight()),body.Height+P(8));
    routeOrder.SetBounds(P(offset+12),P(76),P(inner),P(orderHeight));
    int arrowWidth=Math.Max(70,(inner-16)/4);
    priorityFirst.SetBounds(P(offset+12),P(orderButtons),P(arrowWidth),P(34));
    priorityLast.SetBounds(P(offset+20+arrowWidth),P(orderButtons),P(arrowWidth),P(34));
    applyPriority.SetBounds(P(offset+28+arrowWidth*2),P(orderButtons),P(inner-16-arrowWidth*2),P(34));
    orderReset.SetBounds(P(offset+detailWidth-100),P(8),P(88),P(30));
    orderFeedback.SetBounds(P(offset+12),P(orderButtons+43),P(inner),P(28));
    shortLimit.SetBounds(P(offset+12),P(policyTop+74),P(76),P(28));
    longLimit.SetBounds(P(offset+12),P(policyTop+142),P(76),P(28));
    shortRule.SetBounds(P(offset+112),P(policyTop+74),P(inner-100),P(28));
    longRule.SetBounds(P(offset+112),P(policyTop+142),P(inner-100),P(28));
    applyPolicy.SetBounds(P(offset+12),P(policyTop+190),P(inner),P(34));
    if(conversationPanel!=null){conversationPanel.SetBounds(0,navHeight,ClientSize.Width,Math.Max(1,footer.Top-navHeight));if(compactPage==6)conversationPanel.BringToFront();}
    foreach(var utility in new Control[]{warningPage,settingsPage,cliPage,coworkPage})if(utility!=null)utility.SetBounds(0,navHeight,ClientSize.Width,Math.Max(1,footer.Top-navHeight));
    if(compactPage==7&&warningPage!=null)warningPage.BringToFront();if(compactPage==8&&settingsPage!=null){settingsPage.BringToFront();LayoutSettingsPage();}
    if(compactPage==9&&cliPage!=null)cliPage.BringToFront();
    if(compactPage==10&&coworkPage!=null)coworkPage.BringToFront();
    refresh.Visible=compactPage!=6&&compactPage!=7&&compactPage!=8&&compactPage!=9&&compactPage!=10;quotaStamp.Visible=refresh.Visible;more.Visible=compactPage!=8;
    LayoutCreditControls();
    LayoutOwnerTools();
    laidOutPage=compactPage;laidOutRows=accountRows.Count;
    ClampPopup();
  }
  void ApplyExpandedAppearance(){
    if(cliPage!=null)cliPage.RefreshAppearance();
    ApplyCoworkAppearance();
    foreach(var c in new Control[]{priority,shortLimit,longLimit,shortRule,longRule,accountPicker,routeOrder,orderFeedback}){c.BackColor=TrayTheme.Surface;c.ForeColor=TrayTheme.Text;}
    foreach(var c in new Control[]{useAccount,pauseAccount,autoAccount,resetAccount,applyPriority,priorityFirst,priorityLast,orderReset,slack,guide,applyPolicy})
      {c.BackColor=TrayTheme.Surface;c.ForeColor=TrayTheme.Text;}
    foreach(var tab in tabs){tab.BackColor=TrayTheme.Background;tab.ForeColor=TrayTheme.Text;}
    contentSurface.BackColor=canvas.BackColor=TrayTheme.Background;accountActions.BackColor=TrayTheme.Surface;selectedAccountCaption.BackColor=TrayTheme.Surface;selectedAccountCaption.ForeColor=TrayTheme.Muted;navigation.BackColor=TrayTheme.Background;loginAccount.BackColor=accountMore.BackColor=TrayTheme.Surface;loginAccount.ForeColor=accountMore.ForeColor=TrayTheme.Text;ApplyCreditAppearance();ApplyOwnerToolsAppearance();canvas.Invalidate();
  }
  void Card(Graphics g,int x,int y,int width,int height,bool chosen,bool alert=false){
    TrayGlass.Frost(g,new RectangleF(P(x),P(y),P(width),P(height)),P(12),chosen,alert);
  }
  void Bar(Graphics g,int x,int y,int width,double? remaining){
    var track=new RectangleF(P(x),P(y),P(width),P(4));
    using(var brush=new SolidBrush(TrayTheme.Blend(TrayTheme.Surface,TrayTheme.Text,0.13f)))
      using(var shape=TrayGlass.Round(track,P(2)))g.FillPath(brush,shape);
    if(remaining.HasValue){
      float used=(float)Math.Max(0,Math.Min(100,showRemaining?remaining.Value:100-remaining.Value));
      if(used>0)using(var shape=TrayGlass.Round(new RectangleF(P(x),P(y),Math.Max(P(2),P(width*used/100)),P(4)),P(2)))
        using(var brush=new SolidBrush(remaining.Value<=3?TrayTheme.Warning:TrayTheme.Accent))g.FillPath(brush,shape);
    }
  }
  double? Remaining(Dictionary<string,object> row,string key){
    object v;double d;return row!=null&&row.TryGetValue(key,out v)&&v!=null&&Double.TryParse(Convert.ToString(v),out d)&&d>=0&&d<=100?(double?)d:null;
  }
  Dictionary<string,object> CreditSnapshot(Dictionary<string,object> account){
    object value;return account!=null&&account.TryGetValue("resetCreditInventory",out value)?value as Dictionary<string,object>:null;
  }
  void CreditSummary(Dictionary<string,object> account,out string count,out string detail){
    string known=S(account,"resetCredits","");
    count="초기화권 "+(known.Length>0?known:"확인 중");
    detail=Flag(account,"needsReauth")?"로그인 후 다시 조회합니다":"만료 확인 중";
    var inventory=CreditSnapshot(account);
    if(inventory==null)return;
    DateTime observed;
    bool dated=ParseCreditDate(S(inventory,"observedAt",""),out observed)&&observed<=DateTime.UtcNow;
    if(S(inventory,"terminal","")!="PASS"){
      detail="조회 지연";return;
    }
    string number=S(inventory,"availableCount","");
    if(number.Length>0)count="초기화권 "+number;
    object values;var entries=inventory.TryGetValue("credits",out values)?values as System.Collections.IEnumerable:null;
    DateTime nearest=DateTime.MaxValue;
    if(entries!=null)foreach(object entry in entries){
      var row=entry as Dictionary<string,object>;DateTime expires;
      if(row!=null&&ParseCreditDate(S(row,"expiresAt",""),out expires)&&expires>DateTime.UtcNow&&expires<nearest)nearest=expires;
    }
    detail=nearest!=DateTime.MaxValue?"만료 "+nearest.AddHours(9).ToString("MM.dd HH:mm"):
      number=="0"?"없음":"만료 시각 확인 필요";
    if(Flag(inventory,"lookupFailed")||!dated||(DateTime.UtcNow-observed).TotalMinutes>5)detail="이전 조회 · "+detail;
  }
  void PaintOverview(Graphics g,Rectangle clip){
    int width=LogicalContentWidth();
    TextAt(g,showRemaining?"잔여량":"사용량",heading,TrayTheme.Text,12,7,width-100,31);
    TextAt(g,"KST",small,TrayTheme.Muted,width-55,13,43,24);
    var names=new[]{"AICC","웹 GPT","OCX","브라우저"};
    var ready=new[]{B("aiccReady"),B("webReady"),B("ocxReady"),S(Data,"webBrowserStatus","").Contains("실행 중")};
    var statuses=new[]{S(Data,"aiccStatus","확인 중"),S(Data,"webStatus","확인 중"),S(Data,"ocxStatus","확인 중"),S(Data,"webBrowserStatus","확인 중")};
    int tile=Math.Max(1,(width-24)/4);
    for(int i=0;i<4;i++){
      int x=12+i*tile;
      using(var brush=new SolidBrush(ready[i]?TrayTheme.Good:TrayTheme.Muted))g.FillEllipse(brush,P(x),P(53),P(5),P(5));
      TextAt(g,names[i],bold,TrayTheme.Text,x+12,45,tile-16,22);
      string state=ready[i]?"연결됨":statuses[i].Contains("실패")?"조회 지연":statuses[i].Contains("점검")?"점검 필요":"확인 중";
      if(!ready[i])TextAt(g,state,small,TrayTheme.Muted,x+12,64,tile-16,18);
    }
    for(int i=0;i<accountRows.Count;i++){
      var rect=AccountCell(i);int x=rect.X,y=rect.Y,w=rect.Width;float typeScale=textPercent/100f;
      if(P(rect.Bottom)<clip.Top||P(y)>clip.Bottom)continue;
      var row=accountRows[i];bool chosen=i==SelectedIndex(),active=Flag(row,"active");
      string status=S(row,"status");
      Card(g,x,y,w,rect.Height,chosen,status=="한도 차단"||Flag(row,"needsReauth"));
      if(i==hoverAccount&&!chosen)using(var shape=TrayGlass.Round(new RectangleF(P(x),P(y),P(w),P(rect.Height)),P(12)))
        using(var brush=new SolidBrush(Color.FromArgb(7,TrayTheme.Text)))g.FillPath(brush,shape);
      TextAt(g,AccountLabel(row),bold,TrayTheme.Text,x+12,y+(int)(7*typeScale),w-90,24);
      TextAt(g,active?"사용 중":status,small,Flag(row,"needsReauth")||status=="한도 차단"?TrayTheme.Warning:active?TrayTheme.Good:TrayTheme.Muted,x+w-79,y+(int)(9*typeScale),67,22);
            int rank=orderedAccounts.FindIndex(r=>S(r,"identityHash","")==S(row,"identityHash",""));
      TextAt(g,S(row,"plan","-").ToUpperInvariant()+" · "+(rank>=0?(rank+1)+"순위":"순서 확인 중"),small,TrayTheme.Muted,x+12,y+(int)(28*typeScale),w-24,18);
      int half=(w-36)/2,left=x+12,right=x+24+half;
      var shortLeft=Remaining(row,"shortRemaining");var longLeft=Remaining(row,"longRemaining");
      TextAt(g,"5시간",small,TrayTheme.Muted,left,y+(int)(51*typeScale),41,21);
      FigureAt(g,shortLeft.HasValue?(showRemaining?shortLeft.Value:100-shortLeft.Value).ToString("0")+"%":"—",left+41,y+(int)(46*typeScale),half-41,34);
      TextAt(g,S(row,"longLabel","주간"),small,TrayTheme.Muted,right,y+(int)(51*typeScale),41,21);
      FigureAt(g,longLeft.HasValue?(showRemaining?longLeft.Value:100-longLeft.Value).ToString("0")+"%":"—",right+41,y+(int)(46*typeScale),half-41,34);
      Bar(g,left,y+(int)(77*typeScale),half,shortLeft);Bar(g,right,y+(int)(77*typeScale),half,longLeft);
      TextAt(g,"↻ "+S(row,"shortReset","미확인"),small,TrayTheme.Muted,left,y+(int)(83*typeScale),half,18);
      TextAt(g,"↻ "+S(row,"longReset","미확인"),small,TrayTheme.Muted,right,y+(int)(83*typeScale),half,18);
      string count,detail;CreditSummary(row,out count,out detail);
      string recovery=S(row,"recoveryHint","");
      TextAt(g,recovery.Length>0?recovery:count+" · "+detail,small,recovery.Length>0?TrayTheme.Warning:TrayTheme.Muted,x+12,y+(int)(107*typeScale),w-24,20);
    }
    int lines=Math.Max(1,(accountRows.Count+AccountColumns()-1)/AccountColumns());
    if(accountRows.Count==0)TextAt(g,"계정 정보를 불러오는 중입니다. 이전 관찰값이 있으면 먼저 표시합니다.",body,TrayTheme.Muted,18,CompactCardTop+18,width-36,60);
    int policyTop=CompactCardTop+lines*CompactRow+6;
    using(var pen=new Pen(TrayTheme.Edge))g.DrawLine(pen,P(16),P(policyTop),P(width-16),P(policyTop));
    TextAt(g,"자동 전환",bold,TrayTheme.Text,16,policyTop+10,95,24);
    object obj;var policy=Data.TryGetValue("effectivePolicy",out obj)?obj as Dictionary<string,object>:null;
    if(policy==null)TextAt(g,"현재 기준 확인 중",small,TrayTheme.Muted,114,policyTop+12,width-130,22);
    else{
      TextAt(g,"5시간 "+S(policy,"fiveHourUsedThreshold")+"% · "+(S(policy,"fiveHourAction")=="stop"?"새 요청 중지":"다른 계정 사용"),small,TrayTheme.Text,114,policyTop+7,width-130,22);
      TextAt(g,"주간 "+S(policy,"longWindowUsedThreshold")+"% · "+(S(policy,"longWindowAction")=="stop"?"새 요청 중지":"다른 계정 사용"),small,TrayTheme.Muted,114,policyTop+30,width-130,22);
    }
  }
  void PaintExpandedContents(object sender,PaintEventArgs e){
    var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;
    if(compactPage>=4){PaintOwnerTools(g);return;}
    if(compactPage==0){PaintOverview(g,e.ClipRectangle);return;}
    g.TranslateTransform(P(DetailOffset()),0);
    TextAt(g,compactPage==1?"연결 상태":compactPage==2?"사용 순서":"초기화권",heading,TrayTheme.Text,12,8,compactPage==2?PolicyWidth()-124:368,32);
    if(compactPage==1){
      var names=new[]{"AICC 작업공간","웹 GPT","OCX 계정 서비스","브라우저"};
      var status=new[]{S(Data,"aiccStatus"),S(Data,"webStatus"),S(Data,"ocxStatus"),S(Data,"webBrowserStatus")};
      var descriptions=new[]{"작업공간과 연결 터널","진행 중 "+S(Data,"webActiveTurns","?")+"건","진행 중 "+S(Data,"ocxActiveTurns","?")+"건 · "+accountRows.Count+"개 계정","기존 Chrome 연결"};
      for(int i=0;i<4;i++){
        int y=54+i*62;Card(g,12,y,368,56,false);
        TextAt(g,names[i],bold,TrayTheme.Text,22,y+5,160,23);
        TextAt(g,status[i],small,TrayTheme.Muted,188,y+5,180,23);
        TextAt(g,descriptions[i],small,TrayTheme.Muted,22,y+29,346,20);
      }
      object queueValue;var queue=Data.TryGetValue("webQueue",out queueValue)?queueValue as Dictionary<string,object>:null;
      Card(g,12,310,368,132,false);
      TextAt(g,"웹 GPT 개발 큐",bold,TrayTheme.Text,22,316,213,23);
      TextAt(g,S(queue,"status","개발 큐 확인 중"),small,TrayTheme.Muted,22,343,346,22);
      object listValue;int shown=0;
      var values=queue!=null&&queue.TryGetValue("items",out listValue)?listValue as System.Collections.IEnumerable:null;
      if(values!=null)foreach(object entry in values){
        var item=entry as Dictionary<string,object>;if(item==null)continue;
        if(shown>=3)break;
        string target=S(item,"targetRef","");
        string raw=S(item,"status","unknown"),reason=S(item,"reason","NONE");
        string state=raw=="running"?"진행":raw=="paused"?"대기":raw=="completed"?"실행완료":
          raw=="cancelled"?"취소":raw=="failed"?"실패":"확인필요";
        string why=reason=="SUBMISSION_UNCERTAIN"?"전송 불명":reason=="ROLE_FAILED"?"역할 실패":
          reason=="RUN_FAILED"?"작업 실패":reason=="PAUSED"?"일시중지":"원장 상태";
        string id=S(item,"runRef","?");if(id.Length>6)id=id.Substring(0,6);
        if(target.Length>6)target=target.Substring(0,6);
        string label=state+" · 작업#"+id+" · 대화 "+(target.Length>0&&target!="미확인"?"#"+target:"미확인")+" · "+why;
        TextAt(g,label,small,TrayTheme.Text,22,363+shown*20,346,20);shown++;
      }
      if(shown==0)TextAt(g,"표시할 안전한 개별 작업 정보 없음",small,TrayTheme.Muted,22,366,346,19);
      TextAt(g,"제어는 기존 Chrome Queue 패널에서만 가능",small,TrayTheme.Muted,22,425,346,15);
      Card(g,12,446,368,51,false);
      TextAt(g,"트레이 자원 사용",bold,TrayTheme.Text,22,450,346,22);
      TextAt(g,ResourceSummary,small,TrayTheme.Muted,22,474,346,20);
    }else if(compactPage==2){
      int detailWidth=PolicyWidth(),inner=detailWidth-24,top=PolicySectionTop();
      TextAt(g,"선택 → 위·아래 이동 → 저장",body,TrayTheme.Muted,12,44,inner,25);
      using(var pen=new Pen(TrayTheme.Edge))g.DrawLine(pen,P(12),P(top-14),P(detailWidth-12),P(top-14));
      TextAt(g,"한도에 도달하면",bold,TrayTheme.Text,12,top,inner,25);
      TextAt(g,"사용률 기준",small,TrayTheme.Muted,12,top+25,inner,20);
      TextAt(g,"5시간 사용률 (%)",small,TrayTheme.Text,12,top+50,inner,21);
      TextAt(g,"주간 사용률 (%)",small,TrayTheme.Text,12,top+118,inner,21);
      if(!PolicySupported()){
        object obj;var rules=Data.TryGetValue("effectivePolicy",out obj)?obj as Dictionary<string,object>:null;
        TextAt(g,S(rules,"fiveHourUsedThreshold")+"% · "+(S(rules,"fiveHourAction")=="stop"?"새 요청 중지":"다음 계정으로 전환"),body,TrayTheme.Text,12,top+74,inner,28);
        TextAt(g,S(rules,"longWindowUsedThreshold")+"% · "+(S(rules,"longWindowAction")=="stop"?"새 요청 중지":"다음 계정으로 전환"),body,TrayTheme.Text,12,top+142,inner,28);
        TextAt(g,"연결된 서비스에서 한도 설정을 변경할 수 없습니다.",small,TrayTheme.Muted,12,top+190,inner,34);
      }
    }else PaintCreditContents(g);
  }
}
