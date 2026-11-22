using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

// An explicit local launcher. Route admission and inference belong to the managed CLI.
internal sealed class AiccCodexCliDialog : Form {
  static string lastFolder="";
  string route;
  readonly string helper,shell,guide;
  readonly ComboBox routeChoice=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Fill};
  readonly ComboBox accountChoice=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Fill};
  readonly Label summary=new Label{AutoSize=true,Dock=DockStyle.Fill,Padding=new Padding(0,0,0,10)};
  readonly Font uiFont=new Font(TrayTheme.TextFont,10);
  readonly TextBox folder=new TextBox{Dock=DockStyle.Fill};
  readonly TextBox model=new TextBox{Text="",Dock=DockStyle.Fill};
  readonly ComboBox effort=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Fill};
  readonly Label hint=new Label{AutoSize=true,Dock=DockStyle.Fill,Padding=new Padding(0,8,0,8)};
  readonly Button start=new DarkTrayButton{Text="터미널에서 시작",AutoSize=true};
  readonly ToolTip tips=new ToolTip{ShowAlways=true,AutoPopDelay=20000};
  internal AiccCodexCliDialog(string selectedRoute,string launcher,string powershell,string userGuide):this(selectedRoute,launcher,powershell,userGuide,false){}
  internal AiccCodexCliDialog(string selectedRoute,string launcher,string powershell,string userGuide,bool embedded){
    if(selectedRoute!="ocx"&&selectedRoute!="native")throw new ArgumentException("Unknown route");
    route=selectedRoute;helper=launcher;shell=powershell;guide=userGuide;
    Text="Codex CLI · "+(route=="ocx"?"OCX":"Native");Font=uiFont;
    BackColor=TrayTheme.Background;ForeColor=TrayTheme.Text;StartPosition=FormStartPosition.CenterParent;
    AutoScaleMode=AutoScaleMode.Dpi;MinimumSize=new Size(580,440);Size=new Size(660,490);
    MaximizeBox=false;MinimizeBox=false;KeyPreview=true;
    if(embedded){TopLevel=false;FormBorderStyle=FormBorderStyle.None;MinimumSize=Size.Empty;ShowInTaskbar=false;}
    var page=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(20),ColumnCount=2,RowCount=10,AutoScroll=true};
    page.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,115));page.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));Controls.Add(page);
    page.Layout+=(s,e)=>{int width=Math.Max(115,TextRenderer.MeasureText("실행 경로",folder.Font).Width+24);if(page.ColumnStyles[0].Width!=width)page.ColumnStyles[0].Width=width;};
    page.Controls.Add(summary,0,0);page.SetColumnSpan(summary,2);
    routeChoice.Items.AddRange(new object[]{"OCX · 계정 풀","Native · 공식 Codex"});routeChoice.AccessibleName="Codex CLI 실행 경로";
    AddRow(page,"실행 경로",routeChoice,1);routeChoice.SelectedIndexChanged+=(s,e)=>{route=routeChoice.SelectedIndex==0?"ocx":"native";UpdateRoute();};
    accountChoice.Items.AddRange(new object[]{"자동 선택 · 기본","1번 우선 · 자동 전환","2번 우선 · 자동 전환","3번 우선 · 자동 전환","4번 우선 · 자동 전환","1번 엄격 고정","2번 엄격 고정","3번 엄격 고정","4번 엄격 고정"});accountChoice.SelectedIndex=0;accountChoice.AccessibleName="OCX 계정 번호와 전환 방식";
    AddRow(page,"계정 번호",accountChoice,2);accountChoice.SelectedIndexChanged+=(s,e)=>RefreshAvailability();
    routeChoice.SelectedIndex=route=="ocx"?0:1;
    AddRow(page,"작업 폴더",folder,3);folder.Text=lastFolder;folder.AccessibleName="Git 저장소 루트 폴더";
    var browse=new DarkTrayButton{Text="폴더 선택…",AutoSize=true};
    Configure(browse,".git이 있는 저장소 루트를 고릅니다. 폴더를 선택하는 것만으로 작업을 시작하지 않습니다.",()=>{
      using(var picker=new FolderBrowserDialog{Description="Codex로 작업할 Git 저장소 루트를 선택하세요",ShowNewFolderButton=false,SelectedPath=Directory.Exists(folder.Text)?folder.Text:Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)}){
        if(picker.ShowDialog(this)==DialogResult.OK)folder.Text=picker.SelectedPath;
      }
    });page.Controls.Add(browse,1,4);
    AddRow(page,"모델",model,5);model.AccessibleName="Codex 모델 ID";
    effort.Items.AddRange(new object[]{"사용자 설정 상속","medium","high"});effort.SelectedIndex=0;effort.AccessibleName="추론 수준";AddRow(page,"추론 수준",effort,6);
    var note=new Label{Text="기본은 사용자 설정 상속입니다. 새 터미널에서 지시문을 입력합니다.\n번호 우선은 시작 선호이며 실제 배정은 OCX 영수증에서 확인합니다. OCX는 이전 차례 완료와 기록 이동 가능성을 확인한 다음 미전송 요청에서 같은 대화를 이어갈 수 있습니다.\n활성 요청·같은 대화의 불명 요청·이동 불가한 파일/서버 참조는 보류합니다. 엄격 고정은 전환하지 않습니다. 모든 모드는 현재 OCX 차단 정책(5시간 97%·장기 98%, 명시 월간전용 구분)을 따릅니다. Native 자동 우회는 없습니다.",AutoSize=true,Dock=DockStyle.Fill,Padding=new Padding(0,12,0,4)};
    page.Controls.Add(note,0,7);page.SetColumnSpan(note,2);
    page.Controls.Add(hint,0,8);page.SetColumnSpan(hint,2);
    var actions=new FlowLayoutPanel{AutoSize=true,Dock=DockStyle.Fill,WrapContents=true};page.Controls.Add(actions,0,9);page.SetColumnSpan(actions,2);
    Configure(start,"선택한 Git 폴더에서 이 경로의 새 Codex CLI 터미널을 엽니다. 실제 연결 결과와 오류는 터미널에서 확인합니다.",Launch);actions.Controls.Add(start);
    var help=new DarkTrayButton{Text="사용법 · F1",AutoSize=true};Configure(help,"Native·OCX 차이와 터미널·일반 지피티 사용법을 엽니다.",OpenGuide);actions.Controls.Add(help);
    if(!embedded){var close=new DarkTrayButton{Text="닫기",AutoSize=true};Configure(close,"이 창만 닫습니다. 이미 연 CLI 터미널은 계속 사용할 수 있습니다.",Close);actions.Controls.Add(close);CancelButton=close;}
    tips.SetToolTip(routeChoice,"이 작업에 사용할 OCX 또는 Native를 고릅니다. 선택만으로 실행하거나 Desktop 설정을 바꾸지 않습니다.");
    tips.SetToolTip(accountChoice,"자동/우선은 OCX가 적격 계정을 배정합니다. 동일 대화의 전환에는 완료·기록 이동 가능 조건이 필요합니다. 엄격 고정도 현재 OCX 차단 정책을 지킵니다.");
    tips.SetToolTip(folder,"작업할 Git 저장소 루트를 입력하거나 폴더 선택을 누르세요.");tips.SetToolTip(model,"선택 경로에서 실제 제공하는 모델 ID를 입력하세요. 비워두면 사용자 설정을 상속합니다. 명시한 모델만 전달합니다.");tips.SetToolTip(effort,"기본은 사용자 설정 상속입니다. 명시 선택한 medium/high만 전달합니다.");
    folder.TextChanged+=(s,e)=>RefreshAvailability();model.TextChanged+=(s,e)=>RefreshAvailability();
    KeyDown+=(s,e)=>{if(e.KeyCode==Keys.F1){OpenGuide();e.Handled=true;}else if(e.KeyCode==Keys.Escape&&!embedded){Close();e.Handled=true;}};
    AcceptButton=start;RefreshAppearance();
  }
  internal void SelectRoute(string selectedRoute){if(selectedRoute!="ocx"&&selectedRoute!="native")throw new ArgumentException("Unknown route");routeChoice.SelectedIndex=selectedRoute=="ocx"?0:1;UpdateRoute();}
  void UpdateRoute(){Text="Codex CLI · "+(route=="ocx"?"OCX":"Native");summary.Text=route=="ocx"?"OCX · 계정 풀 또는 번호 고정으로 새 CLI 작업":"Native · 독립 정비 전용 native profile (공유 HOME)";accountChoice.Enabled=route=="ocx";RefreshAvailability();}
  internal void ShowHelp(){OpenGuide();}
  internal void RefreshAppearance(){BackColor=TrayTheme.Background;ForeColor=TrayTheme.Text;foreach(var field in new Control[]{folder,model,effort,routeChoice,accountChoice}){field.BackColor=TrayTheme.Surface;field.ForeColor=TrayTheme.Text;}RefreshAvailability();}
  void AddRow(TableLayoutPanel page,string label,Control field,int row){page.Controls.Add(new Label{Text=label,AutoSize=true,Padding=new Padding(0,5,0,5)},0,row);page.Controls.Add(field,1,row);}
  void Configure(Button button,string description,Action action){button.Padding=new Padding(10,5,10,5);button.Margin=new Padding(0,4,10,4);button.BackColor=TrayTheme.Surface;button.ForeColor=TrayTheme.Text;button.AccessibleDescription=description;tips.SetToolTip(button,description);button.Click+=(s,e)=>action();}
  string Unavailable(){
    if(!File.Exists(helper)||!File.Exists(shell))return "CLI 실행기 또는 PowerShell 설치가 필요합니다. AICC 설치를 적용한 뒤 다시 여세요.";
    if(String.IsNullOrWhiteSpace(folder.Text)||!Directory.Exists(folder.Text))return "먼저 작업할 Git 폴더를 선택하세요.";
    if(!Directory.Exists(Path.Combine(folder.Text,".git"))&&!File.Exists(Path.Combine(folder.Text,".git")))return ".git이 있는 저장소 루트를 선택하세요. Git worktree도 사용할 수 있습니다.";
    if(folder.Text.IndexOfAny(new[]{'"','\r','\n','\0'})>=0)return "작업 폴더 경로를 다시 선택하세요.";
    if(!String.IsNullOrWhiteSpace(model.Text)&&!System.Text.RegularExpressions.Regex.IsMatch(model.Text??"",@"\A[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}\z"))return "모델 ID를 입력하세요. 예: gpt-6.1-sol";
    return "";
  }
  void RefreshAvailability(){string reason=Unavailable();start.Enabled=reason.Length==0;int choice=accountChoice.SelectedIndex;string account=route=="ocx"&&choice>0?" · "+(choice<=4?choice:choice-4)+"번 "+(choice<=4?"우선 · 자동 전환":"엄격 고정"):"";hint.Text=reason.Length>0?reason:"준비됨 · "+(route=="ocx"?"OCX":"Native")+account+" 경로의 새 터미널을 엽니다. 실제 모델 접수는 터미널에서 확인하세요.";hint.ForeColor=reason.Length>0?TrayTheme.Warning:TrayTheme.Text;}
  static string Quote(string value){if(value==null||value.IndexOfAny(new[]{'"','\r','\n','\0'})>=0)throw new ArgumentException("Invalid launcher argument");return "\""+value+"\"";}
  void Launch(){
    RefreshAvailability();if(!start.Enabled)return;
    try{
      string directory=Path.GetFullPath(folder.Text).TrimEnd(Path.DirectorySeparatorChar);
      string arguments="-NoLogo -NoProfile -NoExit -File "+Quote(helper)+" -Route "+route+" -Workspace "+Quote(directory);
      if(!String.IsNullOrWhiteSpace(model.Text))arguments+=" -Model "+Quote(model.Text.Trim());
      if(effort.SelectedIndex>0)arguments+=" -ReasoningEffort "+Convert.ToString(effort.SelectedItem);
      if(route=="ocx"&&accountChoice.SelectedIndex>0){int choice=accountChoice.SelectedIndex;arguments+=choice<=4?" -PreferredAccount "+choice:" -Account "+(choice-4);}
      using(var child=Process.Start(new ProcessStartInfo(shell,arguments){UseShellExecute=true,WindowStyle=ProcessWindowStyle.Normal,WorkingDirectory=directory})){}
      lastFolder=directory;hint.ForeColor=TrayTheme.Text;hint.Text="터미널 열기를 요청했습니다. 연결 성공·실제 작업 결과는 열린 터미널에서 확인하세요.";
    }catch{hint.ForeColor=TrayTheme.Warning;hint.Text="터미널을 열지 못했습니다. 설치와 폴더 접근을 확인한 뒤 다시 선택하세요.";}
  }
  void OpenGuide(){try{Process.Start(new ProcessStartInfo(guide){UseShellExecute=true});}catch{hint.Text="설명서를 열지 못했습니다. AICC 사용자 설명서를 확인하세요.";}}
  protected override void Dispose(bool disposing){base.Dispose(disposing);if(disposing){tips.Dispose();uiFont.Dispose();}}
}
