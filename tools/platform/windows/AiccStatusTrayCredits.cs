using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

internal sealed partial class StatusPopup {
  const int CreditListTop=168, CreditRowHeight=83;
  internal Action<Dictionary<string,object>,string> ResetCreditsRequested;
  Button creditBack,creditReload,creditUse;
  readonly List<Dictionary<string,object>> creditEntries=new List<Dictionary<string,object>>();
  string creditAccountHash="",creditRequestId="",creditMessage="초기화권 목록을 조회하세요.";
  int? creditAvailable;
  int selectedCredit=-1,confirmCredit=-1;
  bool creditBusy,creditVerified;
  DateTime creditObservedUtc=DateTime.MinValue,creditConfirmDeadline=DateTime.MinValue;

  void InitializeCreditUI(){
    creditBack=MakeButton(contentSurface,"계정으로 돌아가기",()=>SetCompactPage(0));
    creditReload=MakeButton(contentSurface,"목록 새로고침",StartCreditLookup);
    creditUse=MakeButton(contentSurface,"계정 초기화권 1장 사용",ConfirmCreditConsumption);
    tips.SetToolTip(creditReload,"선택한 계정의 초기화권 목록과 만료 시각을 OCX에서 새로 확인합니다.");
    tips.SetToolTip(creditUse,"특정 초기화권을 지정할 수 없습니다. OCX가 해당 계정의 1장을 선택하여 사용합니다.");
    CreditControls();
  }
  void OpenCreditInventoryFor(Dictionary<string,object> target){
    if(target==null||Loading||ControlsLocked||B("controlNeedsReconcile"))return;
    string hash=S(target,"identityHash",""),selector=S(target,"selector","");
    if(hash.Length!=64||String.IsNullOrWhiteSpace(selector))return;
    int index=accountRows.FindIndex(row=>S(row,"identityHash","")==hash&&S(row,"selector","")==selector&&Flag(row,"displayNameVerified"));
    if(index<0)return;
    Pick(index);OpenCreditInventory();
  }
  void OpenCreditInventory(){
    var account=Selected();
    if(account==null||!Flag(account,"displayNameVerified")||S(account,"identityHash","").Length!=64)return;
    SetCompactPage(3);
    StartCreditLookup();
  }
  void ClearCreditInventory(){
    creditEntries.Clear();creditAvailable=null;selectedCredit=-1;confirmCredit=-1;
    creditVerified=false;creditBusy=false;creditObservedUtc=DateTime.MinValue;
    creditAccountHash="";creditRequestId="";creditMessage="초기화권 목록을 조회하세요.";
  }
  void StartCreditLookup(){
    var account=Selected();
    if(creditBusy){ShowNotice("중복 목록 조회 억제 · 기존 요청 진행 중");return;}
    if(account==null||ResetCreditsRequested==null){ShowNotice("실패 · 목록 조회 연결/선택 계정 확인 필요");return;}
    if(S(account,"identityHash","").Length!=64||!Flag(account,"displayNameVerified"))return;
    creditAccountHash=S(account,"identityHash","");creditRequestId=Guid.NewGuid().ToString("N");
    creditEntries.Clear();creditAvailable=null;selectedCredit=-1;confirmCredit=-1;
    ShowNotice("초기화권 목록 조회 요청");creditVerified=false;creditBusy=true;creditMessage="OCX에서 초기화권을 확인하는 중...";
    CreditControls();LayoutExpandedDpi();canvas.Invalidate();
    ResetCreditsRequested(account,creditRequestId);
  }
  internal void ReceiveCreditInventory(Dictionary<string,object> result){
    if(IsDisposed||compactPage!=3||creditAccountHash!=S(Selected(),"identityHash","")||
       result==null||S(result,"identityHash","")!=creditAccountHash||S(result,"requestId","")!=creditRequestId)return;
    creditBusy=false;creditEntries.Clear();creditAvailable=null;selectedCredit=-1;confirmCredit=-1;creditVerified=false;
    object value;
    if(S(result,"terminal","")=="PASS"&&result.TryGetValue("credits",out value)){
      var records=value as IEnumerable;
      if(records!=null){
        foreach(object entry in records){
          var row=entry as Dictionary<string,object>;
          DateTime utc;
          if(row==null||!ParseCreditDate(S(row,"expiresAt",""),out utc))continue;
          creditEntries.Add(row);
        }
      }
      int count;
      if(Int32.TryParse(S(result,"availableCount",""),out count)&&count>=0)creditAvailable=count;
      DateTime observed;creditVerified=ParseCreditDate(S(result,"observedAt",""),out observed)&&observed<=DateTime.UtcNow;
      if(creditVerified)creditObservedUtc=observed;
      creditMessage=creditAvailable.HasValue?"OCX에서 확인한 수량 "+creditAvailable+"장":"사용 가능한 수량을 확인하지 못했습니다.";
    }else{
      creditMessage="초기화권을 조회하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.";
    }
    CreditControls();LayoutExpandedDpi();canvas.Invalidate();
  }
  internal void RefreshCreditDetails(){
    if(compactPage==3){ClearCreditInventory();StartCreditLookup();}
    else ClearCreditInventory();
  }
  static bool ParseCreditDate(string iso,out DateTime utc){
    return DateTime.TryParse(iso,CultureInfo.InvariantCulture,DateTimeStyles.AdjustToUniversal|DateTimeStyles.AssumeUniversal,out utc)&&
      utc.Year>=2020&&utc.Year<=2100;
  }
  static string CreditKst(string iso){
    DateTime utc;if(!ParseCreditDate(iso,out utc))return "시각 미확인";
    try{return TimeZoneInfo.ConvertTimeFromUtc(utc,TimeZoneInfo.FindSystemTimeZoneById("Korea Standard Time")).ToString("MM.dd HH:mm",CultureInfo.InvariantCulture);}
    catch{return utc.ToString("MM.dd HH:mm",CultureInfo.InvariantCulture)+" UTC";}
  }
  static string CreditRemaining(string iso){
    DateTime utc;if(!ParseCreditDate(iso,out utc))return "시간 확인 필요";
    var left=utc-DateTime.UtcNow;
    if(left<=TimeSpan.Zero)return "만료";
    if(left.TotalDays>=1)return ((int)left.TotalDays)+"일 "+left.Hours+"시간";
    if(left.TotalHours>=1)return ((int)left.TotalHours)+"시간 "+left.Minutes+"분";
    return Math.Max(1,(int)Math.Ceiling(left.TotalMinutes))+"분";
  }
  bool CreditUsable(int index){
    DateTime expires;
    return index>=0&&index<creditEntries.Count&&ParseCreditDate(S(creditEntries[index],"expiresAt",""),out expires)&&expires>DateTime.UtcNow;
  }
  int CreditAt(Point location){
    if(compactPage!=3)return -1;
    int y=(int)Math.Floor(location.Y/Math.Max(scale,0.1f));
    int idx=(y-CreditListTop)/CreditRowHeight;
    if(y<CreditListTop||idx<0||idx>=creditEntries.Count||y>=CreditListTop+(idx+1)*CreditRowHeight-5)return -1;
    return location.X>=P(DetailOffset()+12)&&location.X<P(DetailOffset()+380)?idx:-1;
  }
  void ChooseCredit(Point location){
    int index=CreditAt(location);
    if(index<0||creditBusy)return;
    ShowNotice("초기화권 항목 선택 완료 · 소비 미실행");selectedCredit=index;confirmCredit=-1;creditConfirmDeadline=DateTime.MinValue;
    CreditControls();canvas.Invalidate();
  }
  void ConfirmCreditConsumption(){
    var account=Selected();
    if(account==null||!creditVerified||creditBusy||!creditAvailable.HasValue||creditAvailable.Value<=0||
       DateTime.UtcNow-creditObservedUtc>TimeSpan.FromSeconds(60)||!CreditUsable(selectedCredit)||
       Loading||ControlsLocked||B("controlNeedsReconcile")){ShowNotice("초기화 미실행 · 목록/잔여 수량/시각/반영 확인 필요");CreditControls();return;}
    if(confirmCredit==selectedCredit&&DateTime.UtcNow<=creditConfirmDeadline){
      // The owner API accepts an account ID only; it does not accept a credit ID.
      // OCX chooses which credit is spent. Do not claim the highlighted row was redeemed.
      confirmCredit=-1;creditVerified=false;CreditControls();
      RunSelected("reset",null);return;
    }
    confirmCredit=selectedCredit;creditConfirmDeadline=DateTime.UtcNow.AddSeconds(10);
    ShowNotice("선택 항목은 참고용 · OCX가 "+AccountLabel(account)+"의 1장을 선택합니다. 10초 안에 다시 누르세요.");
    CreditControls();
  }
  int CreditPageHeight(){return CreditListTop+Math.Max(1,Math.Min(48,creditEntries.Count))*CreditRowHeight+91;}
  void CreditControls(){
    if(creditBack==null)return;
    bool visible=compactPage==3;
    creditBack.Visible=creditReload.Visible=creditUse.Visible=visible;
    creditReload.Enabled=visible&&!creditBusy&&!Loading&&Selected()!=null;
    bool fresh=DateTime.UtcNow-creditObservedUtc<=TimeSpan.FromSeconds(60);
    creditUse.Enabled=visible&&!creditBusy&&!Loading&&!ControlsLocked&&!B("controlNeedsReconcile")&&
      creditVerified&&fresh&&creditAvailable.HasValue&&creditAvailable.Value>0&&CreditUsable(selectedCredit);
    if(DateTime.UtcNow>creditConfirmDeadline)confirmCredit=-1;
    creditUse.Text=confirmCredit==selectedCredit&&confirmCredit>=0?"사용 확정":"1장 사용";
    ((DarkTrayButton)creditUse).Primary=confirmCredit==selectedCredit&&confirmCredit>=0;
    creditBack.Invalidate();creditReload.Invalidate();creditUse.Invalidate();
  }
  void LayoutCreditControls(){
    if(creditBack==null)return;
    int offset=DetailOffset();
    creditBack.SetBounds(P(offset+18),P(88),P(124),P(32));
    creditReload.SetBounds(P(offset+148),P(88),P(105),P(32));
    creditUse.SetBounds(P(offset+260),P(88),P(115),P(32));
  }
  void ApplyCreditAppearance(){
    if(creditBack==null)return;
    foreach(var btn in new[]{creditBack,creditReload,creditUse}){btn.BackColor=TrayTheme.Surface;btn.ForeColor=TrayTheme.Text;}
  }
  void PaintCreditContents(Graphics g){
    var account=Selected();
    TextAt(g,AccountLabel(account),bold,TrayTheme.Text,17,55,345,25);
    TextAt(g,creditBusy?"목록 조회 중":creditMessage,small,TrayTheme.Muted,17,123,356,20);
    TextAt(g,"조회 "+(creditObservedUtc==DateTime.MinValue?"미확인":creditObservedUtc.AddHours(9).ToString("MM.dd HH:mm:ss")+" KST · "+Elapsed(creditObservedUtc)),small,TrayTheme.Muted,17,143,356,16);
    int top=CreditListTop;
    if(creditEntries.Count==0){
      Card(g,12,top,368,74,false);
      TextAt(g,creditBusy?"초기화권을 조회하고 있습니다.":creditVerified?"표시할 초기화권이 없습니다.":"'목록 새로고침'을 눌러 확인하세요.",
        small,TrayTheme.Muted,21,top+22,349,28);
    }
    for(int i=0;i<creditEntries.Count;i++){
      var c=creditEntries[i];int y=top+i*CreditRowHeight;bool chosen=selectedCredit==i,usable=CreditUsable(i);
      Card(g,12,y,368,CreditRowHeight-5,chosen,!usable);
      TextAt(g,(chosen?"● ":"○ ")+"초기화권 "+(i+1),bold,usable?TrayTheme.Text:TrayTheme.Muted,22,y+5,179,23);
      TextAt(g,"남은 "+CreditRemaining(S(c,"expiresAt","")),bold,usable?TrayTheme.Text:Color.FromArgb(238,145,145),216,y+5,151,23);
      TextAt(g,"지급 "+CreditKst(S(c,"grantedAt","")),small,TrayTheme.Muted,22,y+32,348,20);
      TextAt(g,"만료 "+CreditKst(S(c,"expiresAt",""))+" KST",small,TrayTheme.Muted,22,y+52,348,19);
    }
    int note=top+Math.Max(1,creditEntries.Count)*CreditRowHeight;
    TextAt(g,"항목을 선택해 확인할 수 있습니다. 실제 소비 항목은 OCX가 결정합니다.",small,TrayTheme.Muted,17,note+8,357,22);
    TextAt(g,"목록은 직접 조회한 시점의 정보입니다. 사용 전 60초 이내 재조회가 필요합니다.",small,TrayTheme.Muted,17,note+31,357,23);
    if(creditVerified&&DateTime.UtcNow-creditObservedUtc>TimeSpan.FromSeconds(60))
      TextAt(g,"이전 조회입니다. 다시 조회한 뒤 사용하세요.",small,Color.FromArgb(238,145,145),17,note+53,356,22);
  }
  internal void PreviewCreditInventory(){
    var account=Selected();if(account==null)return;
    SetCompactPage(3);creditAccountHash=S(account,"identityHash","");creditRequestId=Guid.NewGuid().ToString("N");
    var now=DateTime.UtcNow;
    var fake=new Dictionary<string,object>{{"terminal","PASS"},{"identityHash",creditAccountHash},{"requestId",creditRequestId},{"availableCount",3},{"observedAt",now.ToString("o")},
      {"credits",new object[]{
        new Dictionary<string,object>{{"grantedAt",now.AddHours(-6).ToString("o")},{"expiresAt",now.AddHours(13).ToString("o")}},
        new Dictionary<string,object>{{"grantedAt",now.AddDays(-1).ToString("o")},{"expiresAt",now.AddDays(2).ToString("o")}},
        new Dictionary<string,object>{{"grantedAt",now.AddDays(-2).ToString("o")},{"expiresAt",now.AddDays(4).ToString("o")}}
      }}};
    ReceiveCreditInventory(fake);
  }
}
