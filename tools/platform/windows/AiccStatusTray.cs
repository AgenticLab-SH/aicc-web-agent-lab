using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Presentation only: never use a masked label to identify an account action.
internal static class TrayAccountLabel {
  internal static string For(Dictionary<string,object> row){
    object value;
    string name=row!=null&&row.TryGetValue("name",out value)&&value!=null?Convert.ToString(value):"";
    name=System.Text.RegularExpressions.Regex.Replace(name,@"[\p{Cc}\p{Cf}]","").Trim();
    if(name.Length==0||name=="미확인"||name=="이름 확인 필요"||name=="계정 확인 필요")return "계정 확인 필요";
    var number=System.Text.RegularExpressions.Regex.Match(name,@"^(\d+번)\s*");
    string prefix=number.Success?number.Groups[1].Value:"";
    string identifier=number.Success?name.Substring(number.Length).Trim(' ','(',')','[',']','·',':','-'):name;
    if(identifier.Length==0)return prefix.Length>0?prefix:"계정 확인 필요";
    int[] parts=System.Globalization.StringInfo.ParseCombiningCharacters(identifier);
    string first=System.Globalization.StringInfo.GetNextTextElement(identifier,0);
    string last=parts.Length>2?identifier.Substring(parts[parts.Length-1]):"";
    return (prefix.Length>0?prefix+" · ":"")+first+"***"+last;
  }
}
internal static class TrayGlass {
  internal static bool TransparencyAllowed{get{return ReadTransparency();}}
  static bool ReadTransparency(){if(SystemInformation.HighContrast||SystemInformation.TerminalServerSession)return false;try{using(var key=Microsoft.Win32.Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"))return key==null||Convert.ToInt32(key.GetValue("EnableTransparency",1))!=0;}catch{return false;}}
  internal static GraphicsPath Round(RectangleF rect,float radius){var path=new GraphicsPath();float d=Math.Min(radius*2,Math.Min(rect.Width,rect.Height));path.AddArc(rect.X,rect.Y,d,d,180,90);path.AddArc(rect.Right-d,rect.Y,d,d,270,90);path.AddArc(rect.Right-d,rect.Bottom-d,d,d,0,90);path.AddArc(rect.X,rect.Bottom-d,d,d,90,90);path.CloseFigure();return path;}
  internal static void Surface(Graphics g,RectangleF rect,float radius,bool interactive,bool selected){using(var shape=Round(rect,radius)){Color fill=selected?Color.FromArgb(TrayTheme.Dark?48:25,TrayTheme.Accent):TrayTheme.Surface;using(var brush=new SolidBrush(fill))g.FillPath(brush,shape);using(var border=new Pen(selected?TrayTheme.Accent:Color.FromArgb(45,TrayTheme.Text)))g.DrawPath(border,shape);}}
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window,int attribute,ref int value,int size);
  static int ColorRef(Color color){return color.R|(color.G<<8)|(color.B<<16);}
  internal static void Frost(Graphics g,RectangleF rect,float radius,bool selected,bool alert){
    if(rect.Width<2||rect.Height<2)return;
    using(var shape=Round(rect,radius)){
      Color surface=selected?TrayTheme.Blend(TrayTheme.Surface,TrayTheme.Accent,TrayTheme.Dark?0.11f:0.07f):TrayTheme.Surface;
      if(SystemInformation.HighContrast){
        using(var brush=new SolidBrush(SystemColors.Window))g.FillPath(brush,shape);
      }else{
        using(var brush=new LinearGradientBrush(rect,TrayTheme.Blend(surface,Color.White,TrayTheme.Dark?0.055f:0.6f),surface,LinearGradientMode.Vertical))g.FillPath(brush,shape);
        var saved=g.Save();g.SetClip(shape);
        using(var highlight=new Pen(Color.FromArgb(TrayTheme.Dark?42:190,Color.White)))g.DrawLine(highlight,rect.Left+radius/2,rect.Top+1,rect.Right-radius/2,rect.Top+1);
        g.Restore(saved);
      }
      Color border=SystemInformation.HighContrast?SystemColors.WindowText:selected?TrayTheme.Accent:alert?TrayTheme.Warning:TrayTheme.Edge;
      using(var pen=new Pen(border,selected?1.3f:1f))g.DrawPath(pen,shape);
    }
  }
  // Restrained native compositing, never a captured-screen blur or animation.
  // System accessibility preferences always take precedence over the material.
  internal static bool Apply(Form form,bool enabled,bool dark,bool pinned){
    if(form==null||form.IsDisposed||!form.IsHandleCreated)return false;
    try{
      bool translucent=enabled&&TransparencyAllowed;
      double opacity=translucent?0.96d:1.0d;
      if(form.Opacity!=opacity)form.Opacity=opacity;
      int mode=dark?1:0;DwmSetWindowAttribute(form.Handle,20,ref mode,4);
      int corner=2;DwmSetWindowAttribute(form.Handle,33,ref corner,4);
      int border=SystemInformation.HighContrast?-1:ColorRef(TrayTheme.Edge);DwmSetWindowAttribute(form.Handle,34,ref border,4);
      int caption=enabled&&TransparencyAllowed?-1:ColorRef(TrayTheme.Background);DwmSetWindowAttribute(form.Handle,35,ref caption,4);
      int text=SystemInformation.HighContrast?-1:ColorRef(TrayTheme.Text);DwmSetWindowAttribute(form.Handle,36,ref text,4);
      int material=enabled&&TransparencyAllowed?(pinned?2:3):1;
      DwmSetWindowAttribute(form.Handle,38,ref material,4);
      return translucent;
    }catch{return false;}
  }
}
internal sealed class DarkTrayButton : Button {
  internal bool Primary,Navigation;
  bool hover,pressed;
  internal DarkTrayButton(){SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.Opaque,true);FlatStyle=FlatStyle.Flat;UseVisualStyleBackColor=false;BackColor=TrayTheme.Surface;ForeColor=TrayTheme.Text;FlatAppearance.BorderSize=0;Cursor=Cursors.Hand;}
  protected override void OnMouseEnter(EventArgs e){hover=true;Invalidate();base.OnMouseEnter(e);}
  protected override void OnMouseLeave(EventArgs e){hover=false;pressed=false;Invalidate();base.OnMouseLeave(e);}
  protected override void OnMouseDown(MouseEventArgs e){pressed=true;Invalidate();base.OnMouseDown(e);}
  protected override void OnMouseUp(MouseEventArgs e){pressed=false;Invalidate();base.OnMouseUp(e);}
  protected override void OnPaintBackground(PaintEventArgs e){e.Graphics.Clear(SystemInformation.HighContrast?SystemColors.Window:BackColor);}
  protected override void OnPaint(PaintEventArgs e){
    var g=e.Graphics;g.Clear(BackColor);g.SmoothingMode=SmoothingMode.AntiAlias;float scale=g.DpiX/96;
    if(Navigation){
      if(Primary||hover&&Enabled)TrayGlass.Frost(g,new RectangleF(2,3,Width-4,Height-6),8*scale,Primary,false);
      TextRenderer.DrawText(g,Text,Font,ClientRectangle,Primary?TrayTheme.Text:TrayTheme.Muted,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix|TextFormatFlags.PreserveGraphicsClipping);
      if(Focused)ControlPaint.DrawFocusRectangle(g,new Rectangle(5,5,Width-10,Height-10),TrayTheme.Text,BackColor);
      return;
    }
    bool hc=SystemInformation.HighContrast;
    Color fill=hc?SystemColors.ButtonFace:Primary&&Enabled?TrayTheme.Accent:TrayTheme.Blend(TrayTheme.Surface,TrayTheme.Text,pressed?0.08f:hover&&Enabled?0.04f:0f);
    Color text=!Enabled?hc?SystemColors.GrayText:TrayTheme.Muted:Primary?TrayTheme.AccentText:ForeColor;
    var bounds=new RectangleF(1,1,Width-2,Height-2);
    if(Primary&&Enabled){
      using(var shape=TrayGlass.Round(bounds,8*scale))using(var brush=new SolidBrush(fill))g.FillPath(brush,shape);
    }else{
      TrayGlass.Frost(g,bounds,8*scale,false,false);
      if(hover||pressed)using(var shape=TrayGlass.Round(bounds,8*scale))using(var brush=new SolidBrush(Color.FromArgb(pressed?18:9,TrayTheme.Text)))g.FillPath(brush,shape);
    }    TextRenderer.DrawText(g,Text,Font,ClientRectangle,text,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix|TextFormatFlags.PreserveGraphicsClipping);
    if(Focused)using(var ring=TrayGlass.Round(new RectangleF(3,3,Width-6,Height-6),3*scale))using(var pen=new Pen(hc?SystemColors.WindowText:TrayTheme.Text,1.5f))g.DrawPath(pen,ring);
  }
}

internal static class TrayTheme {
  static bool dark=ReadDark(); internal static bool Dark {get{return dark;}} internal static void Refresh(){dark=ReadDark();accent=ReadAccent();} static bool ReadDark(){try{using(var key=Microsoft.Win32.Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"))return key==null||Convert.ToInt32(key.GetValue("AppsUseLightTheme",0))==0;}catch{return true;}}
  [DllImport("dwmapi.dll")] static extern int DwmGetColorizationColor(out uint color,out bool opaque);
  static Color accent=ReadAccent();
  static Color ReadAccent(){return dark?Color.FromArgb(108,184,255):Color.FromArgb(0,101,210);}
  internal static string TextFont=FindFont("Segoe UI Variable Text","Segoe UI");
  internal static string DisplayFont=FindFont("Segoe UI Variable Display",TextFont);
  internal static string KoreanFont=FindFont("Pretendard",FindFont("Malgun Gothic",TextFont));
  internal static string IconFont=FindFont("Segoe Fluent Icons","Segoe MDL2 Assets");
  static string FindFont(string preferred,string fallback){try{using(var family=new FontFamily(preferred))return family.Name;}catch(ArgumentException){return fallback;}}
  internal static Color AccentText{get{return SystemInformation.HighContrast?SystemColors.HighlightText:accent.GetBrightness()>0.5f?Color.Black:Color.White;}}
  internal static Color Background {get{return SystemInformation.HighContrast?SystemColors.Window:Dark?Color.FromArgb(23,31,44):Color.FromArgb(239,245,252);}}
  internal static Color Surface {get{return SystemInformation.HighContrast?SystemColors.Window:Dark?Color.FromArgb(37,49,66):Color.FromArgb(248,251,255);}}
  internal static Color Text {get{return SystemInformation.HighContrast?SystemColors.WindowText:Dark?Color.FromArgb(244,248,255):Color.FromArgb(23,37,54);}}
  internal static Color Muted {get{return SystemInformation.HighContrast?SystemColors.WindowText:Dark?Color.FromArgb(188,201,219):Color.FromArgb(77,94,116);}}
  internal static Color Blend(Color first,Color second,float amount){
    return Color.FromArgb((int)(first.R+(second.R-first.R)*amount),(int)(first.G+(second.G-first.G)*amount),(int)(first.B+(second.B-first.B)*amount));
  }
  internal static Color Edge{get{return SystemInformation.HighContrast?SystemColors.WindowText:Dark?Color.FromArgb(72,91,116):Color.FromArgb(194,210,231);}}
  internal static Color Warning{get{return SystemInformation.HighContrast?SystemColors.WindowText:Dark?Color.FromArgb(245,170,125):Color.FromArgb(160,73,30);}}
  internal static Color Good{get{return SystemInformation.HighContrast?SystemColors.WindowText:Dark?Color.FromArgb(108,210,168):Color.FromArgb(22,127,87);}}
  internal static Color Accent {get{return SystemInformation.HighContrast?SystemColors.Highlight:accent;}}
}
internal sealed class TrayCanvas : Panel {
  internal ScrollableControl ScrollOwner;
  internal TrayCanvas(){SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.Opaque,true);DoubleBuffered=true;ResizeRedraw=true;AutoScroll=true;}
  protected override void OnPaintBackground(PaintEventArgs e){using(var brush=new SolidBrush(BackColor))e.Graphics.FillRectangle(brush,e.ClipRectangle);}
  protected override void OnPaint(PaintEventArgs e){
    var state=e.Graphics.Save();
    try{e.Graphics.SetClip(e.ClipRectangle,CombineMode.Intersect);using(var brush=new SolidBrush(BackColor))e.Graphics.FillRectangle(brush,e.ClipRectangle);base.OnPaint(e);}
    finally{e.Graphics.Restore(state);}
  }
  protected override void OnScroll(ScrollEventArgs e){base.OnScroll(e);Invalidate(true);}
  protected override void OnInvalidated(InvalidateEventArgs e){base.OnInvalidated(e);foreach(Control child in Controls)if(child is TrayCanvas)child.Invalidate();}
  protected override void OnMouseWheel(MouseEventArgs e){
    if(ScrollOwner==null){base.OnMouseWheel(e);return;}
    int step=SystemInformation.MouseWheelScrollLines;
    int pixels=step<0?ScrollOwner.ClientSize.Height:Math.Max(1,step)*Font.Height;
    int next=Math.Max(0,-ScrollOwner.AutoScrollPosition.Y-e.Delta*pixels/120);
    ScrollOwner.AutoScrollPosition=new Point(0,Math.Min(Math.Max(0,Height-ScrollOwner.ClientSize.Height),next));
    var handled=e as HandledMouseEventArgs;if(handled!=null)handled.Handled=true;
  }
}
internal sealed partial class StatusPopup : Form {
  internal Dictionary<string,object> Data=new Dictionary<string,object>();
  internal bool Loading,ControlsLocked,RefreshPending;
  internal bool Interacting {get{return interactions>0;}}
  internal int RefreshSeconds=15;
  internal Action RefreshRequested,DashboardRequested,GuideRequested,SlackRequested,ReconcileRequested;
  internal Action<int> AutoRefreshRequested;
  internal Action<Dictionary<string,object>,string,int?> AccountActionRequested;
  internal Action<Dictionary<string,object>> PolicyActionRequested,OrderActionRequested;
  readonly TrayCanvas canvas=new TrayCanvas();
  readonly TrayCanvas contentSurface=new TrayCanvas{AutoScroll=false,TabStop=true};
  readonly Panel footer=new Panel();
  readonly List<Dictionary<string,object>> accountRows=new List<Dictionary<string,object>>();
  readonly List<Button> accountButtons=new List<Button>();
  readonly Dictionary<Button,Dictionary<string,object>> buttonRows=new Dictionary<Button,Dictionary<string,object>>();
  readonly ToolTip tips=new ToolTip{InitialDelay=450,ReshowDelay=100,AutoPopDelay=7000};
  Font body=new Font(TrayTheme.KoreanFont,10f),bold=new Font(TrayTheme.KoreanFont,10.25f,FontStyle.Bold),heading=new Font(TrayTheme.KoreanFont,16,FontStyle.Bold);
  readonly Font icons=new Font(TrayTheme.IconFont,12);
  readonly Button refresh,more,pin;
  string rowStructure="";
  int interactions; string notice; DateTime noticeUntil=DateTime.MinValue;
  float scale=1;
  bool stayOpen=true,glassEnabled=true,glassActive,appearanceUpdating; internal bool PreviewNoActivate;
  const int HeaderHeight=174,RowHeight=146;
  internal StatusPopup(){
    ReadViewPreferences();
    StartPosition=FormStartPosition.Manual;Text="AICC";ShowInTaskbar=false;FormBorderStyle=FormBorderStyle.FixedSingle;MaximizeBox=false;MinimizeBox=false;AutoScaleMode=AutoScaleMode.None;DoubleBuffered=true;Font=body;
    canvas.Dock=DockStyle.Fill;footer.Dock=DockStyle.Bottom;Controls.Add(canvas);Controls.Add(footer);
    canvas.Controls.Add(contentSurface);contentSurface.ScrollOwner=canvas;contentSurface.Paint+=PaintContents;
    refresh=MakeButton(footer,"새로 고침",()=>{RefreshTaskSummary(true);if(RefreshRequested!=null)RefreshRequested();});
    more=MakeButton(footer,"설정",()=>SetCompactPage(8));
    pin=MakeButton(canvas,"\uE77A",TogglePin);pin.Font=icons;pin.AccessibleName="창 고정 해제";((DarkTrayButton)pin).Primary=true;TopMost=true;((DarkTrayButton)refresh).Primary=true;
    tips.SetToolTip(refresh,"지금 최신 사용량과 연결 상태 조회 · 연속 요청은 합칩니다");tips.SetToolTip(more,"한도 설정 · Slack · 초기화 결과 확인 · 투명 배경 · 설명서");
    tips.SetToolTip(pin,"창을 유지합니다. Esc로 숨길 수 있습니다.");
    FormClosing+=(s,e)=>{if(e.CloseReason==CloseReason.UserClosing){e.Cancel=true;Hide();}};
    Deactivate+=(s,e)=>{if(!stayOpen&&interactions==0)Hide();};
    Activated+=(s,e)=>ApplyAppearance();
    LayoutForDpi(); InitializeExpandedUI();ApplyTypography(false);
  }
  int P(float value){return (int)Math.Round(value*scale);}
  static string S(Dictionary<string,object> data,string key,string fallback="미확인"){object value;return data!=null&&data.TryGetValue(key,out value)&&value!=null?Convert.ToString(value):fallback;}
  bool B(string key){object value;return Data.TryGetValue(key,out value)&&value is bool&&(bool)value;}
  static bool Flag(Dictionary<string,object> row,string key){object value;return row!=null&&row.TryGetValue(key,out value)&&value is bool&&(bool)value;}
  static int Priority(Dictionary<string,object> row){object value;return row.TryGetValue("priority",out value)&&value!=null?Convert.ToInt32(value):0;}
  static string AccountLabel(Dictionary<string,object> row){return TrayAccountLabel.For(row);}
  Button MakeButton(Control parent,string label,Action action){var button=new DarkTrayButton{Text=label,Font=body,AccessibleName=label};button.Click+=(s,e)=>action();button.Enter+=(s,e)=>{string text=tips.GetToolTip(button);if(!String.IsNullOrWhiteSpace(text))tips.Show(text,button,0,button.Height,10000);};button.Leave+=(s,e)=>tips.Hide(button);parent.Controls.Add(button);return button;}
  internal void ShowNotice(string text){notice=text;noticeUntil=DateTime.UtcNow.AddSeconds(8);if(compactReady)UpdateFooterFeedback();else canvas.Invalidate();}
  internal void ApplyAppearance(){
    if(appearanceUpdating||IsDisposed||Disposing)return;
    appearanceUpdating=true;
    try{
      TrayTheme.Refresh();
      glassActive=IsHandleCreated&&TrayGlass.Apply(this,glassEnabled,TrayTheme.Dark,stayOpen);
      BackColor=TrayTheme.Background;canvas.BackColor=TrayTheme.Background;footer.BackColor=TrayTheme.Background;ForeColor=TrayTheme.Text;
      foreach(Control control in footer.Controls){control.BackColor=TrayTheme.Background;control.ForeColor=TrayTheme.Text;}
      pin.BackColor=TrayTheme.Surface;pin.ForeColor=TrayTheme.Text;
      foreach(var button in accountButtons){button.BackColor=TrayTheme.Surface;button.ForeColor=TrayTheme.Text;}
      if(compactReady)ApplyExpandedAppearance();
      canvas.Invalidate();
    }finally{appearanceUpdating=false;}
  }
  internal void SetTransparency(bool value){
    glassEnabled=value;
    try{
      ApplyAppearance();
      if(value&&!glassActive){ShowNotice("기본 유리 질감 적용 · 시스템 배경 효과는 지원 환경에서 표시됩니다.");}
      else ShowNotice(glassActive?"글래스 켜짐":"글래스 꺼짐");
      SaveViewPreferences();
    }catch(Exception){
      glassEnabled=false;
      try{Opacity=1.0d;}catch(Exception){}
      ShowNotice("화면 효과를 적용하지 못해 기본 화면으로 돌아갑니다.");
    }
  }
  internal void StressTransparency(int loops){
    for(int i=0;i<loops;i++){
      SetTransparency(i%2==0);Application.DoEvents();
      if(IsDisposed||!IsHandleCreated)throw new InvalidOperationException("Visual effect disposed tray");
    }
    SetTransparency(false);
    if(Math.Abs(Opacity-1.0d)>0.001d)throw new InvalidOperationException("Opacity was not restored");
  }
  void LayoutForDpi(){if(compactReady){LayoutExpandedDpi();return;}using(var g=CreateGraphics())scale=g.DpiX/96;
    var area=Screen.FromControl(this).WorkingArea;int content=HeaderHeight+Math.Max(1,accountRows.Count)*RowHeight+28;
    ClientSize=new Size(P(448),Math.Min(P(content+64),Math.Max(P(320),area.Height-P(48))));footer.Height=P(64);canvas.AutoScrollMinSize=new Size(0,P(content));
    refresh.SetBounds(P(16),P(14),P(284),P(36));more.SetBounds(P(312),P(14),P(120),P(36));
    pin.SetBounds(P(396),P(16),P(36),P(32));
    for(int i=0;i<accountButtons.Count;i++){int row=i/2;accountButtons[i].SetBounds(P(i%2==0?28:268),P(HeaderHeight+row*RowHeight+104),P(i%2==0?232:144),P(34));}
  }
  internal void RenderState(){if(compactReady){RenderExpandedState();return;}
    var rows=new List<Dictionary<string,object>>();object value;var source=Data.TryGetValue("accounts",out value)?value as System.Collections.IEnumerable:null;
    if(source!=null)foreach(object item in source){var row=item as Dictionary<string,object>;if(row!=null)rows.Add(row);}
    rows.Sort((a,b)=>{int selected=Flag(b,"active").CompareTo(Flag(a,"active"));if(selected!=0)return selected;int priority=Priority(b).CompareTo(Priority(a));return priority!=0?priority:String.Compare(S(a,"name"),S(b,"name"),StringComparison.Ordinal);});
    var structure=new StringBuilder();foreach(var row in rows)structure.Append(S(row,"selector")+":"+S(row,"identityHash")+";");
    bool rebuild=structure.ToString()!=rowStructure;
    accountRows.Clear();accountRows.AddRange(rows);
    if(rebuild){foreach(var button in accountButtons){tips.SetToolTip(button,null);canvas.Controls.Remove(button);button.Dispose();}accountButtons.Clear();buttonRows.Clear();rowStructure=structure.ToString();
      foreach(var row in rows){Button use=null,details=null;
        use=MakeButton(canvas,"계정 전환",()=>{Dictionary<string,object> current;if(buttonRows.TryGetValue(use,out current))RequestAccount(current,"use",null);});
        details=MakeButton(canvas,"계정 관리",()=>{Dictionary<string,object> current;if(buttonRows.TryGetValue(details,out current)&&!Loading)ShowMenu(AccountMenu(current),details);});
        accountButtons.Add(use);accountButtons.Add(details);
      }
    }
    bool locked=ControlsLocked||B("controlNeedsReconcile");
    for(int i=0;i<rows.Count;i++){
      var row=rows[i];var use=accountButtons[i*2];var details=accountButtons[i*2+1];buttonRows[use]=row;buttonRows[details]=row;
      bool selected=Flag(row,"active");string status=S(row,"status");
      use.Text="이 계정으로 전환";use.Visible=!selected;use.Enabled=!Loading&&!locked&&!selected&&!Flag(row,"paused")&&!new[]{"한도 차단","로그인 필요","확인 필요","선택 미확인"}.ContainsStatus(status);
      ((DarkTrayButton)use).Primary=false;details.Enabled=!Loading&&!locked;
      use.AccessibleName=AccountLabel(row)+" · "+use.Text;details.AccessibleName=AccountLabel(row)+" · 계정 관리";
      tips.SetToolTip(use,selected?"마지막 로컬 관찰에서 선택된 계정 · 진행 중 개별 요청의 계정과는 다를 수 있습니다.":"실행 전에 실제 계정과 한도를 다시 확인합니다.");
      tips.SetToolTip(details,"일시 중지/재개 · 우선순위 · 초기화권 · 자동 선택");
      use.BackColor=details.BackColor=TrayTheme.Surface;use.ForeColor=details.ForeColor=TrayTheme.Text;
    }
    refresh.Text=Loading?"처리 중…":"새로 고침";refresh.Enabled=!Loading;more.Enabled=!Loading;
    if(rebuild)LayoutForDpi();canvas.Invalidate();
  }
  ContextMenuStrip CreateTrayMenu(){return new ContextMenuStrip{BackColor=TrayTheme.Surface,ForeColor=TrayTheme.Text,Font=body,Renderer=new DarkTrayMenuRenderer(),ShowImageMargin=false};}
  void ShowMenu(ContextMenuStrip menu,Control anchor){
    if(menu==null||menu.IsDisposed||anchor==null||anchor.IsDisposed)return;
    interactions++;
    bool closed=false;
    menu.Closed+=(s,e)=>{
      if(closed)return;
      closed=true;
      if(interactions>0)interactions--;
      // Closing fires inside ToolStripDropDown.OnItemClicked. NEVER dispose inside that stack.
      if(IsDisposed||Disposing)return;
      try{
        BeginInvoke((Action)(()=>{
          if(!menu.IsDisposed)menu.Dispose();
        }));
      }catch(InvalidOperationException){}
    };
    try{menu.Show(anchor,new Point(0,anchor.Height));}
    catch{
      if(!closed){if(interactions>0)interactions--;menu.Dispose();}
      throw;
    }
  }
  internal void StressMenuLifecycle(int count){
    for(int i=0;i<count;i++){
      var menu=CreateTrayMenu();bool activated=false;
      var item=new ToolStripMenuItem("반투명 창");
      item.Click+=(s,e)=>{activated=true;SetTransparency(i%2==0);};
      menu.Items.Add(item);
      ShowMenu(menu,more);
      Application.DoEvents();
      item.PerformClick();
      menu.Close();
      if(menu.IsDisposed)throw new InvalidOperationException("Menu disposed before mouse click returned");
      Application.DoEvents();
      if(!activated||!menu.IsDisposed)throw new InvalidOperationException("Menu click did not finish cleanly");
    }
    SetTransparency(false);
  }
  internal ContextMenuStrip AccountMenu(Dictionary<string,object> row){
    var menu=CreateTrayMenu();
    menu.Items.Add(AccountLabel(row)).Enabled=false;
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("사용 순서 편집",null,(s,e)=>{SetCompactPage(2);routeOrder.Focus();});
    menu.Items.Add("수동 고정 해제 · 자동 선택",null,(s,e)=>RequestAccount(row,"unpin",null)).Enabled=Flag(row,"active");
    object policyObject,enabledObject;
    var quotaPolicy=Data.TryGetValue("effectivePolicy",out policyObject)?policyObject as Dictionary<string,object>:null;
    bool known=row.TryGetValue("quotaProtectionEnabled",out enabledObject)&&enabledObject is bool;
    bool protection=known&&(bool)enabledObject;
    var quotaItem=new ToolStripMenuItem(known?(protection?"한도 사전 차단: 켜짐 → 끄기":"한도 사전 차단: 꺼짐 → 켜기"):"한도 사전 차단: 연결 확인 필요");
    quotaItem.Enabled=known&&Flag(quotaPolicy,"accountQuotaProtectionSupported")&&!Loading&&!ControlsLocked&&!B("controlNeedsReconcile");
    quotaItem.Click+=(s,e)=>{
      if(Loading||ControlsLocked||B("controlNeedsReconcile")||PolicyActionRequested==null)return;
      PolicyActionRequested(new Dictionary<string,object>{{"action","quota-protection"},{"selector",S(row,"selector")},{"identityHash",S(row,"identityHash")},{"enabled",!protection}});
    };
    menu.Items.Add(quotaItem);
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("로그인 관리 열기",null,(s,e)=>OpenSelectedLogin());
    return menu;
  }
  void OpenGlobalMenu(){
    var menu=CreateTrayMenu();
    var interval=new ToolStripMenuItem("화면 갱신");
    foreach(int seconds in new[]{15,60,0}){
      int selected=seconds;
      var item=new ToolStripMenuItem(seconds==0?"창 열 때만":seconds+"초마다 캐시 반영"){Checked=RefreshSeconds==seconds};
      item.Click+=(s,e)=>{if(AutoRefreshRequested!=null)AutoRefreshRequested(selected);};
      interval.DropDownItems.Add(item);
    }
    menu.Items.Add(interval);
    AddViewOptions(menu);
    menu.Items.Add("OCX 사전 경고 설정…",null,(s,e)=>OpenOcxWarningSettings());
    var glass=new ToolStripMenuItem("글래스 효과"){Checked=glassEnabled};glass.Click+=(s,e)=>SetTransparency(!glassEnabled);menu.Items.Add(glass);
    menu.Items.Add("상태 복사",null,(s,e)=>CopyStatus());
    menu.Items.Add("사용 설명서",null,(s,e)=>{if(GuideRequested!=null)GuideRequested();});
    ShowMenu(menu,more);
  }
  internal void OpenOcxWarningSettings(){SetCompactPage(7);if(!Visible)Toggle();}
  void SetPinned(bool value){stayOpen=value;TopMost=value;pin.Text=value?"\uE77A":"\uE718";pin.AccessibleName=value?"창 고정 해제":"창 고정";((DarkTrayButton)pin).Primary=value;ApplyAppearance();pin.Invalidate();}
  void TogglePin(){SetPinned(!stayOpen);ShowNotice(stayOpen?"창 고정 완료":"창 고정 해제 완료");}
  void RequestAccount(Dictionary<string,object> row,string action,int? value){
    if(Loading){ShowNotice("중복 요청 억제 · 진행 중인 변경을 기다리세요");return;}
    if(ControlsLocked||B("controlNeedsReconcile")){ShowNotice("결과 불확실 · 반영 확인이 먼저 필요합니다");return;}
    if(row==null||S(row,"identityHash","").Length!=64||!Flag(row,"displayNameVerified")){ShowNotice("실패 · 계정 신원을 확인하지 못했습니다");return;}
    if((action=="priority"&&value==Priority(row))||(action=="use"&&Flag(row,"active"))||(action=="pause"&&Flag(row,"paused"))||(action=="resume"&&!Flag(row,"paused"))){ShowNotice("변경없음 · 현재 상태와 같습니다");return;}
    if(AccountActionRequested==null){ShowNotice("실패 · 변경 실행기가 연결되지 않았습니다");return;}
    ShowNotice("계정 변경 요청 · 신원과 미리보기를 확인합니다");AccountActionRequested(row,action,value);
  }
  void OpenPriority(Dictionary<string,object> row){if(Loading||ControlsLocked||B("controlNeedsReconcile"))return;interactions++;try{using(var dialog=new PriorityDialog(Priority(row))){ShowNotice("우선순위 입력 대기");if(dialog.ShowDialog(this)==DialogResult.OK)RequestAccount(row,"priority",dialog.Value);else ShowNotice("취소 · 우선순위 변경 미실행");}}finally{interactions--;}}
  internal void OpenPolicy(){if(Loading||ControlsLocked||B("controlNeedsReconcile"))return;interactions++;try{using(var dialog=new WindowPolicyDialog(Data)){ShowNotice("한도 정책 입력 대기");if(dialog.ShowDialog(this)==DialogResult.OK&&PolicyActionRequested!=null)PolicyActionRequested(dialog.Value);else ShowNotice("취소 · 한도 정책 변경 미실행");}}finally{interactions--;}}
  void TextAt(Graphics g,string text,Font font,Color color,int x,int y,int width,int height){TextRenderer.DrawText(g,text,font,new Rectangle(P(x),P(y),P(width),P(height)),color,TextFormatFlags.NoPadding|TextFormatFlags.NoPrefix|TextFormatFlags.EndEllipsis|TextFormatFlags.VerticalCenter|TextFormatFlags.PreserveGraphicsTranslateTransform|TextFormatFlags.PreserveGraphicsClipping);}
  void FigureAt(Graphics g,string text,int x,int y,int width,int height){
    TextRenderer.DrawText(g,text,quotaNumber,new Rectangle(P(x),P(y),P(width),P(height)),TrayTheme.Text,
      TextFormatFlags.NoPadding|TextFormatFlags.NoPrefix|TextFormatFlags.Right|TextFormatFlags.VerticalCenter|TextFormatFlags.PreserveGraphicsTranslateTransform|TextFormatFlags.PreserveGraphicsClipping);
  }
  void WindowQuota(Graphics g,Dictionary<string,object> row,string key,string label,string reset,int x,int y){
    object value;double? remaining=row.TryGetValue(key,out value)&&value!=null?(double?)Convert.ToDouble(value):null;double used=remaining.HasValue?Math.Max(0,Math.Min(100,100-remaining.Value)):0;
    object policyObject;var policy=Data.TryGetValue("effectivePolicy",out policyObject)?policyObject as Dictionary<string,object>:null;object thresholdValue;
    double threshold=policy!=null&&policy.TryGetValue(key=="shortRemaining"?"fiveHourUsedThreshold":"longWindowUsedThreshold",out thresholdValue)?Convert.ToDouble(thresholdValue):100;
    Color color=remaining.HasValue&&used>=threshold?(TrayTheme.Dark?Color.FromArgb(255,159,159):Color.FromArgb(176,0,32)):TrayTheme.Accent;
    TextAt(g,label,body,TrayTheme.Muted,x,y,170,16);TextAt(g,remaining.HasValue?used.ToString("0")+"% 사용  ·  "+remaining.Value.ToString("0")+"% 남음":"사용량 미확인",bold,TrayTheme.Text,x,y+17,180,20);
    var track=new RectangleF(P(x),P(y+40),P(176),P(4));using(var shape=TrayGlass.Round(track,P(2)))using(var brush=new SolidBrush(TrayTheme.Dark?Color.FromArgb(67,67,67):Color.FromArgb(225,225,225)))g.FillPath(brush,shape);
    if(remaining.HasValue&&used>0)using(var shape=TrayGlass.Round(new RectangleF(P(x),P(y+40),Math.Max(P(2),P(176*(float)used/100)),P(4)),P(2)))using(var brush=new SolidBrush(color))g.FillPath(brush,shape);
    if(policy!=null){float position=176*(float)threshold/100;using(var pen=new Pen(TrayTheme.Text))g.DrawLine(pen,P(x+position),P(y+38),P(x+position),P(y+47));}
    TextAt(g,"다음 갱신 "+S(row,reset),body,TrayTheme.Muted,x,y+50,184,16);
  }
  void PaintContents(object sender,PaintEventArgs e){if(compactReady){PaintExpandedContents(sender,e);return;}var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;g.TranslateTransform(canvas.AutoScrollPosition.X,canvas.AutoScrollPosition.Y);
    // Keep a fully painted client canvas, also while using window opacity.
    TextAt(g,"AICC",bold,TrayTheme.Text,16,16,240,24);
    Dictionary<string,object> selected=null;int selectedCount=0;foreach(var row in accountRows)if(Flag(row,"active")){selected=row;selectedCount++;}
    string selectedName=selectedCount==1?AccountLabel(selected):B("selectionVerified")?"자동 계정 선택":"현재 계정 확인 중";
    TextAt(g,selectedName,heading,TrayTheme.Text,16,48,416,30);
    TextAt(g,selectedCount==1?"현재 선택 · "+S(selected,"status"):"선택 상태와 사용 가능 상태는 별도로 확인합니다",body,TrayTheme.Muted,16,82,416,20);
    string connections="AICC "+S(Data,"aiccStatus","조회 중")+"   ·   OCX "+S(Data,"ocxStatus","조회 중")+"   ·   Web "+S(Data,"webStatus","조회 중");
    TextAt(g,connections,body,TrayTheme.Text,16,109,416,22);
    TextAt(g,Loading?"최신 상태 조회 중 · 이전 값 유지":DateTime.UtcNow<noticeUntil?notice:B("quotaReadFailed")?"한도 조회 지연 · 마지막 관찰값 유지":"화면 확인 "+S(Data,"observedKst","미확인")+" KST",body,TrayTheme.Muted,16,134,416,19);
    TextAt(g,ControlsLocked||B("controlNeedsReconcile")?"변경 결과 미확인 · 설정에서 반영 확인":PolicyText(),body,TrayTheme.Muted,16,154,416,18);
    int y=HeaderHeight;
    foreach(var row in accountRows){bool active=Flag(row,"active");var rect=new RectangleF(P(16),P(y),P(416),P(RowHeight-8));using(var shape=TrayGlass.Round(rect,P(8))){using(var brush=new SolidBrush(TrayTheme.Surface))g.FillPath(brush,shape);using(var pen=new Pen(active?TrayTheme.Accent:Color.FromArgb(40,TrayTheme.Text),active?1.5f:1f))g.DrawPath(pen,shape);}
      TextAt(g,AccountLabel(row),bold,TrayTheme.Text,28,y+10,218,24);TextAt(g,active?"현재 선택 · "+S(row,"status"):S(row,"status"),body,TrayTheme.Muted,248,y+10,164,24);
      WindowQuota(g,row,"shortRemaining","5시간","shortReset",28,y+35);WindowQuota(g,row,"longRemaining",S(row,"longLabel"),"longReset",228,y+35);
      y+=RowHeight;
    }
    if(accountRows.Count==0){TextAt(g,Loading?"계정 정보를 가져오는 중입니다":"계정 정보를 확인하지 못했습니다",bold,TrayTheme.Text,28,y+28,384,30);TextAt(g,"새로 고침으로 다시 조회할 수 있습니다.",body,TrayTheme.Muted,28,y+65,384,22);y+=RowHeight;}
    TextAt(g,"한도 캐시 "+AgeText()+" · 계정 조작 전 다시 확인",body,TrayTheme.Muted,16,y+2,416,22);
  }
  DateTime lastQuotaUtc=DateTime.MinValue,lastQuotaOldestUtc=DateTime.MinValue,lastCollectorUtc=DateTime.MinValue;
  bool lastQuotaReadFailed;
  internal void AcceptSnapshot(Dictionary<string,object> snapshot){
    var next=new Dictionary<string,object>(snapshot);
    if(Flag(next,"diagnosticsPending")&&Data.ContainsKey("observedAt")){
      foreach(string key in new[]{"aiccReady","aiccStatus","aiccReadFailed","webReady","webStatus","webReadFailed","ocxReady","ocxStatus","ocxReadFailed","webBrowserStatus","webActiveTurns","webBrowserTurns","ocxActiveTurns"}){
        object retained;if(Data.TryGetValue(key,out retained))next[key]=retained;
      }
      next["diagnosticsCached"]=true;
    }
    object rows;var incoming=next.TryGetValue("accounts",out rows)?rows as System.Collections.IEnumerable:null;
    bool hasRows=false;if(incoming!=null)foreach(object row in incoming){hasRows=true;break;}
    if(Flag(next,"quotaReadFailed")&&!hasRows&&Data.TryGetValue("accounts",out rows)){
      var retained=new List<Dictionary<string,object>>();var previous=rows as System.Collections.IEnumerable;
      if(previous!=null)foreach(object item in previous){var row=item as Dictionary<string,object>;if(row!=null){var copy=new Dictionary<string,object>(row);copy["status"]="확인 필요";copy["active"]=false;retained.Add(copy);}}
      next["accounts"]=retained;
    }
    Data=next;RememberObservation();
  }
  internal void RememberObservation(){
    DateTime utc;
    if(ParseCreditDate(S(Data,"quotaObservedAt",""),out utc)&&utc<=DateTime.UtcNow&&utc>lastQuotaUtc)lastQuotaUtc=utc;
    if(ParseCreditDate(S(Data,"quotaOldestObservedAt",""),out utc)&&utc<=DateTime.UtcNow)lastQuotaOldestUtc=utc;
    if(ParseCreditDate(S(Data,"observedAt",""),out utc)&&utc<=DateTime.UtcNow&&utc>lastCollectorUtc)lastCollectorUtc=utc;
    lastQuotaReadFailed=B("quotaReadFailed")||B("collectorError");
  }
  static string Elapsed(DateTime utc){
    if(utc==DateTime.MinValue)return "시각 미확인";
    double seconds=Math.Max(0,(DateTime.UtcNow-utc).TotalSeconds);
    return seconds<60?((int)seconds)+"초 전":seconds<3600?((int)(seconds/60))+"분 전":((int)(seconds/3600))+"시간 전";
  }
  internal string LastQuotaText(){
    return "최근 한도 "+(lastQuotaUtc==DateTime.MinValue?"시각 미확인":lastQuotaUtc.AddHours(9).ToString("MM.dd HH:mm:ss")+" KST · "+Elapsed(lastQuotaUtc));
  }
  internal string LastCollectorText(){
    bool stale=lastQuotaOldestUtc!=DateTime.MinValue&&(DateTime.UtcNow-lastQuotaOldestUtc).TotalSeconds>120;
    return "수집 "+(lastCollectorUtc==DateTime.MinValue?"미확인":lastCollectorUtc.AddHours(9).ToString("HH:mm:ss")+" KST")+" · "+(lastQuotaReadFailed?"조회실패 · 이전 값":stale?"오래됨 · 가장 오래된 한도 "+Elapsed(lastQuotaOldestUtc):lastQuotaUtc==DateTime.MinValue?"한도 시각 미확인":"한도 시각 확인됨");
  }
  // S-TRAY: a later complete snapshot proves no receipt still needs reconciliation.
  internal void ReleaseChangeLock(){ControlsLocked=false;Data["quotaStatus"]="반영 확인됨 · 남은 변경 기록 없음 · 조작 잠금 해제";ShowNotice("반영 확인됨 · 조작 잠금 해제");RenderState();}
  internal void BeginChange(){Loading=true;ShowNotice("변경 요청 접수 · 신원/미리보기 확인 후 진행 중");RenderState();}
  internal void CompleteChange(Dictionary<string,object> result){
    Loading=false;string outcome=S(result,"terminal","UNCERTAIN");
    bool known=outcome=="PASS"||outcome=="RECONCILED"||outcome=="HOLD"||outcome=="FAIL"||outcome=="CANCELLED"||outcome=="NOOP";
    bool uncertain=!known||outcome=="UNCERTAIN"||outcome=="DISPATCHING"||((outcome=="FAIL"||outcome=="HOLD")&&Flag(result,"mutationDispatched"));
    bool localPending=result!=null&&result.ContainsKey("localMetadataSynced")&&result["localMetadataSynced"] is bool&&!(bool)result["localMetadataSynced"];
    ControlsLocked=uncertain||localPending;
    if(orderSaving){
      orderSaving=false;
      if(outcome=="PASS"&&!localPending){orderDirty=false;orderConflict=false;orderBaseline="";}
    }
    object state;if(result!=null&&result.TryGetValue("state",out state)&&state is Dictionary<string,object>)AcceptSnapshot((Dictionary<string,object>)state);
    string message=uncertain?"결과 불확실 · 자동 재시도 안 함 · 반영 확인 필요":
      outcome=="CANCELLED"?"취소 · 변경 미실행":outcome=="NOOP"?"변경없음 · 현재 상태와 같습니다":
      outcome=="PASS"||outcome=="RECONCILED"?(localPending?"성공 · 서버 저장 완료 · 로컬 반영 확인 필요":Flag(result,"reconciliation")?"성공 · 반영 확인 완료":"성공 · 변경 완료 · 상태 재조회 요청"):
      Flag(result,"mutationDispatched")?"실패 · 실행 영수증의 반영 여부를 확인하세요":"실패 · 변경 미실행 · 상태/운영 버전을 확인하세요";
    if(outcome=="PASS"){
      if(result.ContainsKey("changed")&&result["changed"] is bool&&!(bool)result["changed"])message="변경없음 · 현재 상태와 같습니다";
      string code=S(result,"resetCode","");
      if(code=="reset")message=localPending?"성공 · 초기화 완료 · 로컬 반영 확인 필요":"성공 · 초기화 완료 · 상태 재조회 요청";
      else if(code=="already_redeemed")message="변경없음 · 기존 초기화 처리 결과 · 중복 소비 없음";
      else if(code=="nothing_to_reset")message="변경없음 · 초기화할 사용 한도가 없습니다";
      else if(code=="no_credit")message="변경없음 · 사용 가능한 초기화권이 없습니다";
    }
    if(S(result,"reason","")=="no_confirmed_reset_credits"&&!uncertain)message="실패 · 초기화권 없음 / 수량 확인 실패 · 소비하지 않음";
    Data["quotaStatus"]=message;ShowNotice(message);RenderState();
  }
  string AgeText(){object age;if(!Data.TryGetValue("quotaAgeSeconds",out age)||age==null)return "시각 미확인";double seconds=Convert.ToDouble(age);return seconds<60?((int)seconds)+"초 전":seconds<3600?((int)(seconds/60))+"분 전":((int)(seconds/3600))+"시간 전";}
  string PolicyText(){object value;var policy=Data.TryGetValue("effectivePolicy",out value)?value as Dictionary<string,object>:null;if(policy==null)return S(Data,"quotaStatus","한도 보호 설정 확인 중");return "보호 기준  5시간 "+S(policy,"fiveHourUsedThreshold")+"% · "+(S(policy,"fiveHourAction")=="stop"?"중지":"전환")+"   /   주간 "+S(policy,"longWindowUsedThreshold")+"% · "+(S(policy,"longWindowAction")=="stop"?"중지":"전환");}
  internal Action<string> StatusCopyWriter=Clipboard.SetText;
  internal void CopyStatus(){var text=new StringBuilder();ShowNotice("상태 복사 요청");text.AppendLine(LastQuotaText());text.AppendLine(LastCollectorText());text.AppendLine("AICC "+S(Data,"aiccStatus")+" · OCX "+S(Data,"ocxStatus")+" · Web "+S(Data,"webStatus"));text.AppendLine(PolicyText()+" · 한도 캐시 "+AgeText());foreach(var row in accountRows)text.AppendLine(AccountLabel(row)+" · "+(Flag(row,"active")?"현재 선택 · ":"")+S(row,"status")+" · 5시간 남음 "+S(row,"shortRemaining")+"% / "+S(row,"shortReset")+" · "+S(row,"longLabel")+" 남음 "+S(row,"longRemaining")+"% / "+S(row,"longReset"));try{StatusCopyWriter(text.ToString());ShowNotice("상태를 복사했습니다");}catch(ExternalException){ShowNotice("클립보드 사용 중 · 잠시 후 다시 복사하세요");}}
  Screen invocationScreen;
  bool clampingPopup,manualPopupPosition,movingPopup;
  Rectangle PopupWorkArea(){return (Visible?Screen.FromRectangle(Bounds):invocationScreen??Screen.FromControl(this)).WorkingArea;}
  void ClampPopup(){
    if(clampingPopup||IsDisposed)return;clampingPopup=true;
    try{
      Rectangle area=PopupWorkArea();
      int width=Math.Min(Width,Math.Max(1,area.Width)),height=Math.Min(Height,Math.Max(1,area.Height));
      int x=Math.Max(area.Left,Math.Min(Left,area.Right-width)),y=Math.Max(area.Top,Math.Min(Top,area.Bottom-height));
      Rectangle next=new Rectangle(x,y,width,height);if(Bounds!=next)Bounds=next;
    }finally{clampingPopup=false;}
  }
  internal void Toggle(){
    if(Visible){Hide();return;}
    // Every explicit open starts pinned; unpin remains available for this visit.
    SetPinned(true);
    invocationScreen=Screen.FromPoint(Cursor.Position);
    // Select the intended monitor before measuring; old coordinates can refer
    // to a different monitor or to a display that no longer exists.
    if(!manualPopupPosition)Location=invocationScreen.WorkingArea.Location;
    LayoutForDpi();
    if(!manualPopupPosition){
      Rectangle area=invocationScreen.WorkingArea,bounds=invocationScreen.Bounds;
      int x=area.Right-Width-P(8),y=area.Bottom-Height-P(8);
      if(area.Left>bounds.Left)x=area.Left+P(8);
      if(area.Top>bounds.Top)y=area.Top+P(8);
      Location=new Point(x,y);
    }
    ClampPopup();Show();ClampPopup();Activate();
  }
  protected override void OnLocationChanged(EventArgs e){base.OnLocationChanged(e);if(Visible&&!clampingPopup&&!movingPopup)ClampPopup();}
  protected override bool ProcessCmdKey(ref Message msg,Keys key){
    if(compactReady&&(key==(Keys.Control|Keys.D1)||key==(Keys.Control|Keys.D2)||key==(Keys.Control|Keys.D3))){SetCompactPage(key==(Keys.Control|Keys.D1)?0:key==(Keys.Control|Keys.D2)?1:2);return true;}
    if(key==(Keys.Control|Keys.D6)){SetCompactPage(6);return true;}
    if(key==Keys.F5||key==(Keys.Control|Keys.R)){if(compactPage==6&&conversationPanel!=null){conversationPanel.LoadRows();return true;}RefreshTaskSummary(true);if(RefreshRequested!=null)RefreshRequested();return true;}
    if(key==Keys.F1){if(compactPage==6&&conversationPanel!=null){conversationPanel.ShowHelp();return true;}ShowFeatureHelp();return true;}
    if(key==(Keys.Control|Keys.D4)||key==(Keys.Control|Keys.D5)){SetCompactPage(key==(Keys.Control|Keys.D4)?4:5);return true;}
    if(key==(Keys.Control|Keys.Shift|Keys.C)){CopyStatus();return true;}
    if(key==(Keys.Control|Keys.Add)||key==(Keys.Control|Keys.Oemplus)){SetTextPercent(Math.Min(120,textPercent+10));return true;}
    if(key==(Keys.Control|Keys.Subtract)||key==(Keys.Control|Keys.OemMinus)){SetTextPercent(Math.Max(100,textPercent-10));return true;}
    if(key==(Keys.Control|Keys.Oemcomma)){if(!Loading)OpenGlobalMenu();return true;}
    return base.ProcessCmdKey(ref msg,key);
  }
  protected override bool ProcessDialogKey(Keys key){if(key==Keys.Escape){Hide();return true;}return base.ProcessDialogKey(key);}
  protected override bool ShowWithoutActivation {get{return PreviewNoActivate||base.ShowWithoutActivation;}} protected override CreateParams CreateParams {get{var p=base.CreateParams;if(PreviewNoActivate)p.ExStyle |= 0x08000000;return p;}} protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);ApplyAppearance();}
  protected override void WndProc(ref Message m){
    base.WndProc(ref m);
    if(m.Msg==0x0231)movingPopup=true;
    if(m.Msg==0x0232){movingPopup=false;manualPopupPosition=true;invocationScreen=Screen.FromRectangle(Bounds);ClampPopup();}
    if(m.Msg==0x02E0||m.Msg==0x007E||m.Msg==0x001A){LayoutForDpi();ClampPopup();ApplyAppearance();}
    else if(m.Msg==0x031A)ApplyAppearance();
  }
  protected override void OnInvalidated(InvalidateEventArgs e){base.OnInvalidated(e);if(canvas!=null)canvas.Invalidate();}
  protected override void Dispose(bool disposing){
    if(!disposing){base.Dispose(false);return;}
    tips.Dispose();
    // Dispose child controls before the shared fonts they may still reference.
    base.Dispose(true);
    var fonts=new HashSet<Font>{body,bold,heading,icons,small,quotaNumber};
    foreach(var faces in typefaces.Values)foreach(var face in faces)fonts.Add(face);
    foreach(var face in fonts)face.Dispose();
    typefaces.Clear();
  }
}
internal static class TrayStringHelpers {internal static bool ContainsStatus(this string[] values,string status){return Array.IndexOf(values,status)>=0;}}
internal sealed partial class TrayContext : ApplicationContext {
  readonly StatusPopup popup=new StatusPopup();
  readonly NotifyIcon icon;
  readonly List<Icon> statusIcons=new List<Icon>();
  int currentIconState=-1;
  readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
  readonly string node,collector,source;
  bool busy;
  bool exiting;
  bool mutationUncertain;
  volatile bool controlRunning;
  bool requestedSnapshot;DateTime refreshDeadlineUtc=DateTime.MinValue;readonly System.Windows.Forms.Timer feedbackTimer=new System.Windows.Forms.Timer();
  Process collectorProcess;
  readonly object collectorGate=new object();
  Dictionary<string,object> latestData,lastAppliedData;
  DateTime minimumSnapshotUtc=DateTime.MinValue;
  DateTime collectorRetryAfter=DateTime.MinValue;
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);
  internal TrayContext(string nodePath,string collectorPath) {
    node=nodePath;collector=collectorPath;source=Path.GetFullPath(Path.Combine(Path.GetDirectoryName(collector),"..","..",".."));
    var windowHandle=popup.Handle;
    int nativeSize=Math.Max(16,SystemInformation.SmallIconSize.Width);
    for(int state=0;state<3;state++)statusIcons.Add(AiccTrayIdentity.Create(nativeSize,state,SystemInformation.HighContrast,SystemColors.WindowText,SystemColors.Window));
    icon=new NotifyIcon{Icon=statusIcons[0],Text="AICC · 연결과 계정 상태 확인 중",Visible=true};
    popup.Icon=(Icon)statusIcons[0].Clone();    popup.RefreshRequested=RequestRefresh;popup.DashboardRequested=OpenDashboard;popup.GuideRequested=OpenGuide;popup.SlackRequested=OpenSlack;popup.ResetCreditsRequested=LookupCredits;
    popup.VisibleChanged+=(s,e)=>{
      SendCollector("visible",popup.Visible&&popup.RefreshSeconds>0);
      if(popup.Visible){if(popup.RefreshSeconds>0)timer.Start();feedbackTimer.Start();Refresh();popup.RenderState();}
      else{timer.Stop();if(!busy&&!requestedSnapshot)feedbackTimer.Stop();}
    };
    popup.AccountActionRequested=(row,action,value)=>{var request=new Dictionary<string,object>{{"action",action},{"selector",row["selector"]},{"identityHash",row["identityHash"]}};if(value.HasValue)request["priority"]=value.Value;Mutate(request);};
    popup.PolicyActionRequested=Mutate;popup.OrderActionRequested=Mutate;popup.ReconcileRequested=()=>Mutate(new Dictionary<string,object>{{"action","reconcile"}});
    popup.ToolRequested=OpenOwnedTool;popup.TaskSummaryRequested=ReadTaskSummary;popup.ExitRequested=ExitThread;
    var menu=new ContextMenuStrip{BackColor=TrayTheme.Surface,ForeColor=TrayTheme.Text,Renderer=new DarkTrayMenuRenderer()};
    menu.Items.Add("AICC 앱 열기",null,(s,e)=>OpenCommonControl("overview"));
    menu.Items.Add("공통 도구 열기",null,(s,e)=>OpenCommonControl("tools"));
    menu.Items.Add("PC 상태·복구 열기",null,(s,e)=>{if(!popup.Visible)popup.Toggle();else popup.Activate();});
    menu.Items.Add("대화 자동재개 · 최근 대화 선택",null,(s,e)=>{if(!popup.Visible)popup.Toggle();popup.SelectPreviewPage(6);popup.Activate();});
    menu.Items.Add("관제 실행 · 그룹 상태",null,(s,e)=>{
      var panel=typeof(StatusPopup).Assembly.GetType("AiccSupervisedRunsPanel");
      var show=panel==null?null:panel.GetMethod("ShowSingleton",System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic);
      if(show!=null)show.Invoke(null,null);else popup.ShowNotice("관제 패널은 기존 관리 화면에서 확인하세요.");
    });
    var cliMenu=new ToolStripMenuItem("Codex CLI · 경로 선택");
    cliMenu.DropDownItems.Add("OCX로 시작…",null,(s,e)=>OpenOwnedTool("codex-ocx"));
    cliMenu.DropDownItems.Add("Native로 시작…",null,(s,e)=>OpenOwnedTool("codex-native"));
    cliMenu.DropDownItems.Add("CLI 사용법",null,(s,e)=>OpenGuide());
    menu.Items.Add(cliMenu);
    menu.Items.Add("OCX 사전 경고 설정…",null,(s,e)=>popup.OpenOcxWarningSettings());
    menu.Items.Add("상태 복사",null,(s,e)=>popup.CopyStatus());
    menu.Items.Add(new ToolStripSeparator());menu.Items.Add("AICC 상태 종료",null,(s,e)=>ExitThread());icon.ContextMenuStrip=menu;
    popup.AutoRefreshRequested=seconds=>{timer.Stop();if(seconds>0){timer.Interval=seconds*1000;if(popup.Visible)timer.Start();}popup.RefreshSeconds=seconds;SendCollector("visible",popup.Visible&&seconds>0);popup.RenderState();popup.ShowNotice("화면 갱신 변경 완료 · "+(seconds==0?"창 열 때만":seconds+"초 간격"));};
    icon.MouseClick+=(s,e)=>{if(e.Button==MouseButtons.Left)popup.Toggle();};
    timer.Interval=15000;timer.Tick+=(s,e)=>{if(popup.Visible)Refresh();};feedbackTimer.Interval=1000;feedbackTimer.Tick+=(s,e)=>{if(requestedSnapshot&&DateTime.UtcNow>refreshDeadlineUtc){requestedSnapshot=false;popup.RefreshPending=false;popup.Loading=busy;popup.Data["quotaReadFailed"]=true;popup.ShowNotice("조회실패 · 응답 시간 초과 · 이전 조회 시각 유지");popup.RenderState();}else if(popup.Visible)popup.TickFeedback();if(!popup.Visible&&!busy&&!requestedSnapshot)feedbackTimer.Stop();};Refresh();
  }
  static ProcessStartInfo Hidden(string exe,string args){return new ProcessStartInfo(exe,args){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=System.Text.Encoding.UTF8,StandardErrorEncoding=System.Text.Encoding.UTF8};}
  bool SendCollector(string action,bool? value=null){try{if(collectorProcess==null)return false;var command=new Dictionary<string,object>{{"action",action}};if(value.HasValue)command["value"]=value.Value;if(action=="visible"&&popup.RefreshSeconds>0)command["intervalSeconds"]=popup.RefreshSeconds;collectorProcess.StandardInput.WriteLine(new JavaScriptSerializer().Serialize(command));collectorProcess.StandardInput.Flush();return true;}catch{return false;}}
  void LookupCredits(Dictionary<string,object> row,string requestId){
    if(exiting||popup.IsDisposed||row==null)return;
    object s,h;
    if(!row.TryGetValue("selector",out s)||!row.TryGetValue("identityHash",out h))return;
    string selector=Convert.ToString(s),identity=Convert.ToString(h);
    if(!System.Text.RegularExpressions.Regex.IsMatch(selector??"","^[A-Za-z0-9._-]{1,64}$")||
       !System.Text.RegularExpressions.Regex.IsMatch(identity??"","^[a-f0-9]{64}$")||
       !System.Text.RegularExpressions.Regex.IsMatch(requestId??"","^[a-f0-9]{32}$"))return;
    ThreadPool.QueueUserWorkItem(_=>{
      Dictionary<string,object> result=null;
      try{
        var args="\""+collector+"\" --credits "+selector+" "+identity;
        using(var process=Process.Start(Hidden(node,args))){
          var output=process.StandardOutput.ReadToEndAsync();
          var errors=process.StandardError.ReadToEndAsync();
          bool exited=process.WaitForExit(45000);
          if(!exited){try{process.Kill();}catch{}try{process.WaitForExit(2000);}catch{}}
          else if(process.ExitCode==0&&output.Result.Length<32768)
            result=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(output.Result);
        }
      }catch{}
      if(result==null)result=new Dictionary<string,object>{{"terminal","HOLD"},{"reason","credit_lookup_unavailable"},{"identityHash",identity}};
      result["requestId"]=requestId;
      if(exiting||popup.IsDisposed)return;
      try{
        popup.BeginInvoke((Action)(()=>popup.ReceiveCreditInventory(result)));
      }catch(InvalidOperationException){}
    });
  }
  static bool SnapshotFlag(Dictionary<string,object> row,string key){object v;return row!=null&&row.TryGetValue(key,out v)&&v is bool&&(bool)v;}
  static string SnapshotText(Dictionary<string,object> row,string key,string fallback){object v;return row!=null&&row.TryGetValue(key,out v)&&v!=null?Convert.ToString(v):fallback;}
  void UpdateShellStatus(Dictionary<string,object> data){
    bool complete=SnapshotText(data,"snapshotPhase","")=="complete"||SnapshotText(data,"snapshotPhase","")=="credits";
    bool attention=SnapshotFlag(data,"controlNeedsReconcile");
    Dictionary<string,object> active=null;object obj;
    var rows=data.TryGetValue("accounts",out obj)?obj as System.Collections.IEnumerable:null;
    if(rows!=null)foreach(object item in rows){
      var row=item as Dictionary<string,object>;if(row==null)continue;
      if(SnapshotFlag(row,"needsReauth"))attention=true;
      if(SnapshotFlag(row,"active")){
        active=row;
        if(new[]{"한도 차단","로그인 필요","확인 필요","조회 재시도"}.ContainsStatus(SnapshotText(row,"status","")))attention=true;
      }
    }
    bool fresh=false;DateTime observed;
    if(DateTime.TryParse(SnapshotText(data,"quotaOldestObservedAt",""),System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.RoundtripKind,out observed)){
      var age=DateTime.UtcNow-observed.ToUniversalTime();fresh=age.TotalSeconds>=0&&age.TotalSeconds<=120;
    }
    int state=attention?2:complete&&fresh&&!SnapshotFlag(data,"quotaReadFailed")&&SnapshotFlag(data,"aiccReady")&&SnapshotFlag(data,"ocxReady")&&SnapshotFlag(data,"webReady")?1:0;
    if(currentIconState!=state){icon.Icon=statusIcons[state];currentIconState=state;}
    string tooltip=active==null?"AICC · "+(attention?"확인 필요한 계정 있음":"현재 사용 계정 확인 중"):
      "AICC · "+TrayAccountLabel.For(active)+" · "+SnapshotText(active,"status","확인 중");
    if(active!=null){
      double shortLeft,longLeft;
      string a=Double.TryParse(SnapshotText(active,"shortRemaining",""),out shortLeft)?(100-shortLeft).ToString("0")+"%":"?";
      string b=Double.TryParse(SnapshotText(active,"longRemaining",""),out longLeft)?(100-longLeft).ToString("0")+"%":"?";
      tooltip+=" · 사용 5h "+a+" / "+b;
    }
    if(!complete||!fresh||SnapshotFlag(data,"quotaReadFailed"))tooltip+=" · 이전/미확인";
    // NotifyIcon's legacy tooltip contract has a strict 63-character limit.
    icon.Text=tooltip.Length<=63?tooltip:tooltip.Substring(0,62)+"…";
  }
  void RequestRefresh(){
    if(exiting)return;
    if(busy){popup.ShowNotice("조회 대기 · 진행 중인 변경이 끝난 뒤 새로 고침하세요");return;}
    if(requestedSnapshot){popup.ShowNotice("중복 조회 억제 · 기존 최신 조회 요청이 진행 중입니다");return;}
    requestedSnapshot=true;feedbackTimer.Start();refreshDeadlineUtc=DateTime.UtcNow.AddSeconds(70);popup.RefreshPending=true;
    lock(collectorGate){minimumSnapshotUtc=DateTime.UtcNow;latestData=null;}
    popup.ShowNotice("최신 조회 요청 · 이전 조회 시각 유지");Refresh();
    if(!SendCollector("refresh")){requestedSnapshot=false;popup.RefreshPending=false;popup.Loading=false;popup.Data["quotaReadFailed"]=true;popup.ShowNotice("조회실패 · 수집기 연결 없음 · 이전 조회 시각 유지");}
    popup.RenderState();
  }
  void OpenSlack(){popup.ShowNotice("Slack 열기 요청");
    try{
      string state=Environment.GetEnvironmentVariable("AICC_STATE_ROOT");if(String.IsNullOrWhiteSpace(state))state=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center");
      var json=new JavaScriptSerializer();var config=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(state,"notifications","slack-alerts.json")));var target=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(state,"status-tray","slack-navigation.json")));
      string team=Convert.ToString(target["teamId"]),channel=Convert.ToString(target["dmChannelId"]);
      if(Convert.ToInt32(target["schemaVersion"])!=1||Convert.ToString(config["transport"])!="aicc_slack_bot"||team!=Convert.ToString(config["teamId"])||Convert.ToString(target["botUserId"])!=Convert.ToString(config["botUserId"])||Convert.ToString(target["recipientUserId"])!=Convert.ToString(config["recipientUserId"])||!System.Text.RegularExpressions.Regex.IsMatch(team,"^T[A-Z0-9]+$")||!System.Text.RegularExpressions.Regex.IsMatch(channel,"^D[A-Z0-9]+$"))throw new InvalidOperationException();
      try{Process.Start(new ProcessStartInfo("slack://channel?team="+team+"&id="+channel){UseShellExecute=true});}catch(System.ComponentModel.Win32Exception){Process.Start(new ProcessStartInfo("https://app.slack.com/client/"+team+"/"+channel){UseShellExecute=true});}
      popup.ShowNotice("Slack 열기 전달 완료 · 실제 표시 여부는 미확인");
    }catch{popup.Data["quotaStatus"]="Slack 진입 경로 미확인 · 설명서의 한도 조회 안내를 확인하세요";popup.ShowNotice("Slack 진입 경로 미확인 · 설명서의 한도 조회 안내를 확인하세요");popup.Invalidate();}
  }
  void OpenGuide(){popup.ShowNotice("설명서 열기 요청");try{Process.Start(new ProcessStartInfo(Path.Combine(source,"docs","user-guide.html")){UseShellExecute=true});popup.ShowNotice("설명서 열기 전달 완료 · 실제 표시 여부는 미확인");}catch{popup.Data["quotaStatus"]="설명서를 열지 못했습니다";popup.ShowNotice("설명서를 열지 못했습니다");popup.Invalidate();}}
  DateTime nextResourceReadUtc=DateTime.MinValue;
  void UpdateTrayResources(){
    if(DateTime.UtcNow<nextResourceReadUtc)return;
    nextResourceReadUtc=DateTime.UtcNow.AddSeconds(30);
    try{
      using(var current=Process.GetCurrentProcess()){
        double trayMb=current.PrivateMemorySize64/1048576.0,collectorMb=0;
        if(collectorProcess!=null&&!collectorProcess.HasExited){collectorProcess.Refresh();collectorMb=collectorProcess.PrivateMemorySize64/1048576.0;}
        popup.ResourceSummary="전용 메모리 · 트레이 "+trayMb.ToString("0.0")+"MB · 조회기 "+collectorMb.ToString("0.0")+"MB · 합계 "+(trayMb+collectorMb).ToString("0.0")+"MB";
      }
    }catch{popup.ResourceSummary="현재 메모리 측정값을 확인할 수 없습니다.";}
  }
  void UpdateAccountMenu(){popup.RenderState();}
  static Dictionary<string,object> ReadChangeReceipt(string receipt){
    try{
      if(!File.Exists(receipt))return null;
      var value=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(receipt,new UTF8Encoding(false)));
      string terminal=value!=null&&value.ContainsKey("terminal")?Convert.ToString(value["terminal"]):"";
      return terminal=="PASS"||terminal=="HOLD"||terminal=="FAIL"?value:null;
    }catch{return null;}
  }
  void Mutate(Dictionary<string,object> request){
    if(busy||exiting||(controlRunning&&Convert.ToString(request["action"])!="reconcile")||(mutationUncertain&&Convert.ToString(request["action"])!="reconcile")){popup.Data["quotaStatus"]=mutationUncertain?"이전 변경 결과 미확인 · 결과 다시 조회 메뉴를 사용하세요":controlRunning?"이전 변경 처리가 아직 끝나지 않았습니다 · 끝나면 자동 확인":"다른 조회/변경이 끝난 뒤 다시 선택하세요";popup.Invalidate();return;}
    busy=true;feedbackTimer.Start();popup.Loading=true;popup.Data["quotaStatus"]="현재 계정 확인 후 변경 중…";popup.RenderState();
    ThreadPool.QueueUserWorkItem(_=>{
      Dictionary<string,object> result=null;Process p=null;bool exited=true;
      try{
        string state=Environment.GetEnvironmentVariable("AICC_STATE_ROOT");if(String.IsNullOrWhiteSpace(state))state=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center");
        string directory=Path.Combine(state,"status-tray","requests");Directory.CreateDirectory(directory);
        string file=Path.Combine(directory,Guid.NewGuid().ToString("N")+".json");File.WriteAllText(file,new JavaScriptSerializer().Serialize(request),new UTF8Encoding(false));
        p=Process.Start(Hidden(node,"\""+Path.Combine(Path.GetDirectoryName(collector),"tray-control.mjs")+"\" \""+file+"\""));var output=p.StandardOutput.ReadToEndAsync();var error=p.StandardError.ReadToEndAsync();
        // G1-25: tray-control may take preview 90 s + commit 90 s + local sync 50 s + status refresh.
        // Wait past that sum; if it still runs, adopt the durable receipt it wrote instead of
        // declaring the change uncertain. A DISPATCHING/UNCERTAIN receipt stays uncertain.
        exited=p.WaitForExit(330000);
        if(exited){try{result=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(output.Result);}catch{result=null;}}
        else controlRunning=true;
        // S-TRAY: an unreadable stdout (or a timeout) falls back to the durable receipt.
        if(result==null||!result.ContainsKey("terminal"))result=ReadChangeReceipt(file+".result.json")??result;
      }catch{}
      if(exiting||popup.IsDisposed){if(p!=null)p.Dispose();return;}
      try{popup.BeginInvoke((Action)(()=>{busy=false;popup.CompleteChange(result);mutationUncertain=popup.ControlsLocked;lock(collectorGate){minimumSnapshotUtc=DateTime.UtcNow;latestData=null;}popup.ShowNotice(Convert.ToString(popup.Data["quotaStatus"]));SendCollector("refresh");UpdateAccountMenu();if(Convert.ToString(request["action"])=="reset")popup.RefreshCreditDetails();popup.Invalidate();}));}catch(InvalidOperationException){}
      if(p==null)return;
      // S-TRAY: after a timeout keep the change process owned until it exits (its own steps are
      // bounded), then ask for a post-exit snapshot so a settled receipt can release the lock.
      if(!exited){try{p.WaitForExit(600000);}catch{}}
      p.Dispose();
      if(!exited&&!exiting&&!popup.IsDisposed)try{popup.BeginInvoke((Action)(()=>{controlRunning=false;lock(collectorGate){minimumSnapshotUtc=DateTime.UtcNow;latestData=null;}SendCollector("refresh");}));}catch(InvalidOperationException){}
    });
  }
  // S-TRAY: release a stale change lock only when the change process has exited and a complete
  // snapshot taken after it reports no DISPATCHING/UNCERTAIN/unsynced receipt.
  void ReleaseSettledLock(Dictionary<string,object> data){
    if(!mutationUncertain||controlRunning||busy)return;
    string phase=SnapshotText(data,"snapshotPhase","");
    object value;
    if((phase!="complete"&&phase!="credits")||!data.TryGetValue("controlNeedsReconcile",out value)||!(value is bool)||(bool)value)return;
    mutationUncertain=false;popup.ReleaseChangeLock();
  }
  void Refresh(){
    if(exiting||popup.Interacting)return;
    Dictionary<string,object> cached;lock(collectorGate){cached=latestData;}
    if(busy){
      // G1-25: keep showing the read-only collector's latest quota while a change runs.
      // Controls stay locked and the change status text is kept; no collector is (re)started here.
      if(cached!=null&&!Object.ReferenceEquals(cached,lastAppliedData)){object status;popup.Data.TryGetValue("quotaStatus",out status);lastAppliedData=cached;popup.AcceptSnapshot(cached);popup.Loading=true;popup.Data["quotaStatus"]=status;if(popup.Visible)popup.RenderState();UpdateShellStatus(cached);}
      return;
    }
    if(cached!=null&&!Object.ReferenceEquals(cached,lastAppliedData)){lastAppliedData=cached;UpdateTrayResources();popup.Loading=false;popup.AcceptSnapshot(cached);ReleaseSettledLock(cached);if(popup.Visible)popup.RenderState();UpdateShellStatus(cached);}
    if(collectorProcess!=null||DateTime.UtcNow<collectorRetryAfter)return;
    popup.Loading=cached==null;popup.RenderState();
    try{var start=Hidden(node,"\""+collector+"\" --watch");start.RedirectStandardInput=true;collectorProcess=Process.Start(start);}catch{collectorRetryAfter=DateTime.UtcNow.AddSeconds(30);popup.Loading=false;popup.Data["quotaStatus"]="상태 수집기 시작 실패 · 이전 값 유지";popup.ShowNotice("상태 수집기 시작 실패 · 이전 값 유지");popup.Invalidate();return;}
    SendCollector("visible",popup.Visible&&popup.RefreshSeconds>0);
    var ownedCollector=collectorProcess;
    ThreadPool.QueueUserWorkItem(_=>{
      try{
        ownedCollector.StandardError.ReadToEndAsync();
        string line;while(!exiting&&(line=ownedCollector.StandardOutput.ReadLine())!=null){
          Dictionary<string,object> data;try{data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(line);}catch{continue;}
          if(data==null)continue;if(data.ContainsKey("collectorError")){if(!exiting&&!popup.IsDisposed)try{popup.BeginInvoke((Action)(()=>{requestedSnapshot=false;popup.RefreshPending=false;popup.Loading=busy;popup.Data["quotaReadFailed"]=true;popup.Data["quotaStatus"]="조회실패 · 마지막 관찰값 유지";popup.RenderState();popup.ShowNotice("조회 지연 · 마지막 관찰값 유지");popup.Invalidate();}));}catch(InvalidOperationException){}continue;}
          if(!data.ContainsKey("accounts")||!data.ContainsKey("aiccReady"))continue;
          object snapshotAt;DateTime snapshotUtc;if((!data.TryGetValue("collectionStartedAt",out snapshotAt)&&!data.TryGetValue("observedAt",out snapshotAt))||!DateTime.TryParse(Convert.ToString(snapshotAt),System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.RoundtripKind,out snapshotUtc))continue;
          lock(collectorGate){if(snapshotUtc.ToUniversalTime()<minimumSnapshotUtc)continue;latestData=data;}
          if(!exiting&&!popup.IsDisposed)try{popup.BeginInvoke((Action)(()=>{if(!popup.Interacting){if(!busy&&requestedSnapshot){string phase=Convert.ToString(data.ContainsKey("refreshState")?data["refreshState"]:"cached");if(phase=="deferred"){popup.ShowNotice("조회 대기 · 중복 방지 "+Convert.ToString(data["refreshRetryAfterSeconds"])+"초 후 최신 조회");}else if(phase=="requested"){requestedSnapshot=false;popup.RefreshPending=false;popup.ShowNotice(data.ContainsKey("quotaReadFailed")&&Convert.ToBoolean(data["quotaReadFailed"])?"조회실패 · 이전 한도 시각 유지":"조회 완료 · 실제 한도 조회 시각은 별도 표시");}}Refresh();}}));}catch(InvalidOperationException){}
        }
      }
      catch{}
      if(exiting||popup.IsDisposed)return;
      try{popup.BeginInvoke((Action)(()=>{ownedCollector.Dispose();collectorProcess=null;collectorRetryAfter=DateTime.UtcNow.AddSeconds(30);requestedSnapshot=false;popup.RefreshPending=false;popup.Loading=false;popup.Data["quotaReadFailed"]=true;popup.RenderState();lock(collectorGate){latestData=null;}popup.Data["quotaStatus"]="수집 중단 · 표시된 값은 이전 조회입니다";popup.ShowNotice("수집 중단 · 표시된 값은 이전 조회입니다");popup.Invalidate();}));}catch(InvalidOperationException){}
    });
  }
  bool dashboardBusy;void OpenDashboard(){if(dashboardBusy){popup.ShowNotice("중복 열기 억제 · OCX 화면 준비 중");return;}dashboardBusy=true;popup.ShowNotice("OCX 화면 열기 요청");ThreadPool.QueueUserWorkItem(_=>{try{using(var p=Process.Start(Hidden("pwsh.exe","-NoProfile -NonInteractive -File \""+Path.Combine(source,"tools","platform","opencodex","Open-AiccOcxDashboard.ps1")+"\""))){p.StandardOutput.ReadToEndAsync();p.StandardError.ReadToEndAsync();bool completed=p.WaitForExit(90000);bool opened=completed&&p.ExitCode==0;popup.BeginInvoke((Action)(()=>popup.ShowNotice(opened?"OCX 화면 열기 전달 · "+(popup.Data.ContainsKey("loginTargetName")?Convert.ToString(popup.Data["loginTargetName"])+" 계정 로그인 확인":"실제 표시 미확인"):"OCX 화면 열기 실패/시간 초과")));}}catch{if(!popup.IsDisposed)try{popup.BeginInvoke((Action)(()=>popup.ShowNotice("OCX 화면 열기 실패")));}catch(InvalidOperationException){}}finally{dashboardBusy=false;}});}
  protected override void ExitThreadCore(){exiting=true;feedbackTimer.Stop();feedbackTimer.Dispose();timer.Stop();timer.Dispose();if(collectorProcess!=null){try{collectorProcess.StandardInput.Close();}catch{}}icon.Visible=false;icon.Dispose();foreach(var image in statusIcons)image.Dispose();if(popup.Icon!=null)popup.Icon.Dispose();popup.Dispose();base.ExitThreadCore();}
}

internal sealed class PriorityDialog : Form {
  readonly NumericUpDown input=new NumericUpDown{Minimum=-100,Maximum=100};
  internal int Value{get{return Decimal.ToInt32(input.Value);}}
  internal PriorityDialog(int priority){Text="계정 우선순위";ClientSize=new Size(330,130);FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;MinimizeBox=false;StartPosition=FormStartPosition.CenterScreen;BackColor=TrayTheme.Background;ForeColor=TrayTheme.Text;Font=new Font(TrayTheme.TextFont,10.5f);Controls.Add(new Label{Text="큰 값의 계정을 먼저 사용합니다.",AutoSize=true,Location=new Point(16,16)});input.Value=Math.Max(-100,Math.Min(100,priority));input.SetBounds(16,45,290,26);Controls.Add(input);var save=new DarkTrayButton{Text="적용",DialogResult=DialogResult.OK,Location=new Point(210,87)};Controls.Add(save);AcceptButton=save;}
}
internal sealed class WindowPolicyDialog : Form {
  readonly NumericUpDown shortValue=new NumericUpDown{Minimum=1,Maximum=100},longValue=new NumericUpDown{Minimum=1,Maximum=100};
  readonly ComboBox shortAction=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList},longAction=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList};
  internal Dictionary<string,object> Value{get{return new Dictionary<string,object>{{"action","policy"},{"shortThreshold",Decimal.ToInt32(shortValue.Value)},{"longThreshold",Decimal.ToInt32(longValue.Value)},{"shortAction",shortAction.SelectedIndex==1?"stop":"switch"},{"longAction",longAction.SelectedIndex==1?"stop":"switch"}};}}
  internal WindowPolicyDialog(Dictionary<string,object> data){
    Text="5시간 / 주간 한도 정책";ClientSize=new Size(390,215);FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;MinimizeBox=false;StartPosition=FormStartPosition.CenterScreen;BackColor=TrayTheme.Background;ForeColor=TrayTheme.Text;Font=new Font(TrayTheme.TextFont,10.5f);
    object value;var policy=data.TryGetValue("effectivePolicy",out value)?value as Dictionary<string,object>:null;
    bool supported=policy!=null&&policy.ContainsKey("settingsSupported")&&Convert.ToBoolean(policy["settingsSupported"]);
    bool local=policy!=null&&Convert.ToString(policy.ContainsKey("scope")?policy["scope"]:null)=="Windows local pool requests only";
    Controls.Add(new Label{Text=local?"로컬 요청 보호 · 진행 중 요청도 취소 신호 전달":"새 요청의 계정 선택 / 차단 기준",AutoSize=true,Location=new Point(16,15)});
    Controls.Add(new Label{Text="5시간 사용률 (%)",AutoSize=true,Location=new Point(16,55)});Controls.Add(new Label{Text="주간 사용률 (%)",AutoSize=true,Location=new Point(16,98)});
    shortValue.Value=policy!=null&&policy.ContainsKey("fiveHourUsedThreshold")?Math.Max(1,Math.Min(100,Convert.ToInt32(policy["fiveHourUsedThreshold"]))):97;
    longValue.Value=policy!=null&&policy.ContainsKey("longWindowUsedThreshold")?Math.Max(1,Math.Min(100,Convert.ToInt32(policy["longWindowUsedThreshold"]))):97;
    shortValue.SetBounds(145,50,65,26);longValue.SetBounds(145,94,65,26);Controls.Add(shortValue);Controls.Add(longValue);
    foreach(var action in new[]{shortAction,longAction})action.Items.AddRange(new object[]{"다른 계정으로 전환","요청 중지"});
    shortAction.SelectedIndex=policy!=null&&policy.ContainsKey("fiveHourAction")&&Convert.ToString(policy["fiveHourAction"])=="stop"?1:0;longAction.SelectedIndex=policy!=null&&policy.ContainsKey("longWindowAction")&&Convert.ToString(policy["longWindowAction"])=="stop"?1:0;
    shortAction.SetBounds(220,50,155,27);longAction.SetBounds(220,94,155,27);Controls.Add(shortAction);Controls.Add(longAction);
    Controls.Add(new Label{Text=supported?(local?"중단 요청은 재전송 안 함 · 대체 계정 없으면 중지":"안전한 대체 계정이 없으면 새 요청 중지"):"지원 정책을 확인한 뒤 설정할 수 있습니다.",AutoSize=true,Location=new Point(16,138)});
    var save=new DarkTrayButton{Text="적용",Enabled=supported,DialogResult=DialogResult.OK,Location=new Point(295,172)};Controls.Add(save);AcceptButton=save;
  }
}
// Owner-local advisory settings. This never changes OCX admission policy, accounts or services.
internal sealed class OcxQuotaWarningDialog : Form {
  const string ShortWarning="{account}: {window} 한도가 100% 기준 잔여량이 {remaining}%입니다. 긴 작업·병렬 작업을 늘리기 전에 현재 변경과 다음 행동을 저장하세요.";
  const string ShortUrgent="{account}: {window} 한도가 100% 기준 잔여량이 {remaining}%입니다. 현재 작업과 결과 파일·세션 ID를 즉시 저장하고 중단에 대비하세요.";
  const string WeekUrgent="{account}: {window} 한도가 100% 기준 잔여량이 {remaining}%입니다. 현재 작업과 미완료·복구 지점을 즉시 저장하고 한도 초기화 시점에 대비하세요.";
  readonly string settingsPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center","config","ocx-quota-warning.json");
  readonly CheckBox active=new CheckBox{Text="OCX 사전 경고 전체 사용",AutoSize=true};
  readonly CheckBox warningEnabled=new CheckBox{Text="일반 경고 켜기 · 5시간",AutoSize=true};
  readonly CheckBox urgentEnabled=new CheckBox{Text="긴급 경고 켜기 · 5시간 / 주간",AutoSize=true};
  readonly NumericUpDown warning=new NumericUpDown{Minimum=2,Maximum=100,Value=10,Width=100};
  readonly NumericUpDown urgent=new NumericUpDown{Minimum=1,Maximum=99,Value=6,Width=100};
  readonly TextBox shortWarning=new TextBox(),shortUrgent=new TextBox(),weekUrgent=new TextBox();
  readonly TextBox preview=new TextBox{ReadOnly=true,Multiline=true,ScrollBars=ScrollBars.Vertical,Height=110,Dock=DockStyle.Top,TabStop=true};
  readonly Label status=new Label{AutoSize=true,MaximumSize=new Size(650,0)};
  readonly ToolTip help=new ToolTip{AutoPopDelay=15000};
  readonly JavaScriptSerializer serializer=new JavaScriptSerializer();
  readonly Dictionary<string,object> settings;
  readonly Dictionary<string,object> policy;
  string original; readonly Font ownedFont=new Font(TrayTheme.TextFont,10.5f);
  internal static void Open(IWin32Window owner,Dictionary<string,object> data){
    try{using(var dialog=new OcxQuotaWarningDialog(data))dialog.ShowDialog(owner);}
    catch{MessageBox.Show(owner,"설정 파일을 안전하게 읽지 못했습니다. 기존 설정은 보존했습니다. 파일 형식·접근 권한을 확인한 뒤 다시 여세요.","OCX 사전 경고 설정",MessageBoxButtons.OK,MessageBoxIcon.Warning);}
  }
  internal OcxQuotaWarningDialog(Dictionary<string,object> data,bool embedded=false){
    Text="OCX 사전 경고 설정";Font=ownedFont;AutoScaleMode=AutoScaleMode.Font;
    BackColor=TrayTheme.Background;ForeColor=TrayTheme.Text;StartPosition=FormStartPosition.CenterParent;MinimizeBox=false;MaximizeBox=false;
    ClientSize=new Size(740,800);MinimumSize=new Size(620,560);
    var area=Screen.FromControl(this).WorkingArea;Size=new Size(Math.Min(Width,area.Width),Math.Min(Height,area.Height));
    object found;policy=data!=null&&data.TryGetValue("effectivePolicy",out found)?found as Dictionary<string,object>:null;
    original=ReadCurrent();
    settings=original==null?new Dictionary<string,object>{{"schemaVersion",1},{"enabled",true},{"warningMargin",10},{"urgentMargin",6},
      {"messages",new Dictionary<string,object>{{"fiveHourWarning",ShortWarning},{"fiveHourUrgent",ShortUrgent},{"weeklyUrgent",WeekUrgent}}}}:serializer.Deserialize<Dictionary<string,object>>(original);
    if(settings==null||!settings.ContainsKey("schemaVersion")||Convert.ToInt32(settings["schemaVersion"])!=1||
       !settings.ContainsKey("enabled")||!(settings["enabled"] is bool))throw new InvalidDataException();
    var messages=settings.ContainsKey("messages")?settings["messages"] as Dictionary<string,object>:null;
    int w=ReadMargin("warningMargin"),u=ReadMargin("urgentMargin");if(w<=u)throw new InvalidDataException();
    warning.Value=w;urgent.Value=u;active.Checked=(bool)settings["enabled"];
    foreach(string key in new[]{"warningEnabled","urgentEnabled"})if(settings.ContainsKey(key)&&!(settings[key] is bool))throw new InvalidDataException();
    warningEnabled.Checked=!settings.ContainsKey("warningEnabled")||(bool)settings["warningEnabled"];
    urgentEnabled.Checked=!settings.ContainsKey("urgentEnabled")||(bool)settings["urgentEnabled"];
    shortWarning.Text=ReadMessage(messages,"fiveHourWarning");shortUrgent.Text=ReadMessage(messages,"fiveHourUrgent");weekUrgent.Text=ReadMessage(messages,"weeklyUrgent");
    var footer=new FlowLayoutPanel{Dock=DockStyle.Bottom,AutoSize=true,FlowDirection=FlowDirection.RightToLeft,Padding=new Padding(12),WrapContents=true};
    var save=new DarkTrayButton{Text="저장",AutoSize=true,Primary=true,MinimumSize=new Size(90,36)};
    var close=new DarkTrayButton{Text="닫기",AutoSize=true,DialogResult=DialogResult.Cancel,MinimumSize=new Size(90,36)};
    var explain=new DarkTrayButton{Text="사용법 (F1)",AutoSize=true,MinimumSize=new Size(110,36)};
    footer.Controls.Add(save);footer.Controls.Add(close);footer.Controls.Add(explain);
    var scroll=new Panel{Dock=DockStyle.Fill,AutoScroll=true,Padding=new Padding(16)};
    var body=new TableLayoutPanel{Dock=DockStyle.Top,AutoSize=true,ColumnCount=1,Padding=new Padding(0,0,12,12)};
    body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));scroll.Controls.Add(body);Controls.Add(scroll);Controls.Add(footer);
    Add(body,new Label{Text="현재 선택된 OCX 풀 계정만 확인합니다. 5시간은 일반·긴급, 주간은 긴급만 전달합니다.\n같은 대화·계정·단계는 반복하지 않고 회복 후 재진입하면 다시 알립니다. 오래된 값·조회 실패는 경고하지 않습니다.",AutoSize=true,Dock=DockStyle.Top});
    Add(body,active);Add(body,warningEnabled);Add(body,urgentEnabled);
    Add(body,new Label{Text="각 단계를 따로 선택하고 저장하세요. 긴급을 끄면 긴급 구간에서는 일반 경고로 대신 보내지 않습니다. 주간은 긴급 경고만 지원합니다.",AutoSize=true,Dock=DockStyle.Top});
    Add(body,new Label{Text="경고 기준: 100% 기준 잔여량 (%) · OCX 차단선과 별개",AutoSize=true,Dock=DockStyle.Top});
    var values=new TableLayoutPanel{AutoSize=true,Dock=DockStyle.Top,ColumnCount=2};values.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));values.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,110));
    values.Controls.Add(new Label{Text="일반 · 5시간만",AutoSize=true,Anchor=AnchorStyles.Left},0,0);values.Controls.Add(warning,1,0);
    values.Controls.Add(new Label{Text="긴급 · 5시간과 주간",AutoSize=true,Anchor=AnchorStyles.Left},0,1);values.Controls.Add(urgent,1,1);Add(body,values);
    Add(body,new Label{Text="문구 치환: {account} 선택 계정 · {window} 해당 기간 · {used} 사용률 · {limit} 차단선 · {remaining} 100% 기준 잔여량\n각 240자 이내. 경고 단계·기간·실제 관측값과 복구 주의는 자동으로 붙습니다.",AutoSize=true,Dock=DockStyle.Top});
    AddMessage(body,"5시간 일반 경고 문구",shortWarning);AddMessage(body,"5시간 긴급 경고 문구",shortUrgent);AddMessage(body,"주간 긴급 경고 문구",weekUrgent);
    Add(body,new Label{Text="문구 예시 · 실제 알림은 이 조건에 해당될 때만 전달됩니다",AutoSize=true,Dock=DockStyle.Top});
    preview.BackColor=TrayTheme.Surface;preview.ForeColor=TrayTheme.Text;Add(body,preview);
    Add(body,new Label{Text="저장하면 다음 훅 경계부터 읽습니다. 이미 추론 중인 코덱스에는 즉시 끼어들지 못할 수 있습니다.\nOCX 보호 정책·계정·서비스는 바꾸지 않습니다. 끈 상태에서도 문구는 편집할 수 있습니다.",AutoSize=true,Dock=DockStyle.Top});
    Add(body,status);
    Describe(active,"전체 사용 여부입니다. 각 단계 선택과 함께 저장해야 다음 훅부터 적용됩니다. OCX 자체 한도 보호는 유지됩니다.");
    Describe(warningEnabled,"일반 단계만 켜거나 끕니다. 5시간 잔여량이 일반 기준 이하이고 긴급 기준보다 클 때 전달합니다.");
    Describe(urgentEnabled,"긴급 단계만 켜거나 끕니다. 5시간 또는 주간 잔여량이 긴급 기준 이하일 때 전달합니다.");
    foreach(var toggle in new[]{active,warningEnabled,urgentEnabled})toggle.CheckedChanged+=(s,e)=>UpdatePreview();
    Describe(warning,"5시간 일반 경고의 100% 기준 잔여 %입니다. 긴급 기준보다 커야 합니다.");
    Describe(urgent,"5시간과 주간 긴급 경고의 100% 기준 잔여 %입니다. 주간 일반 경고는 보내지 않습니다.");
    Describe(save,"이 Windows 사용자의 공통 경고 설정과 문구를 저장합니다. 계정이나 서비스는 재시작하지 않습니다.");
    Describe(preview,"현재 입력 문구와 차단선으로 만든 예시입니다. 알림 전송은 하지 않습니다.");
    warning.ValueChanged+=(s,e)=>UpdatePreview();urgent.ValueChanged+=(s,e)=>UpdatePreview();
    foreach(var box in new[]{shortWarning,shortUrgent,weekUrgent})box.TextChanged+=(s,e)=>UpdatePreview();
    save.Click+=(s,e)=>Save();explain.Click+=(s,e)=>ShowHelp();HelpRequested+=(s,e)=>{ShowHelp();e.Handled=true;};
    scroll.SizeChanged+=(s,e)=>{foreach(Control item in body.Controls)if(item is Label)((Label)item).MaximumSize=new Size(Math.Max(180,scroll.ClientSize.Width-52),0);};
    AcceptButton=save;CancelButton=close;if(embedded){TopLevel=false;FormBorderStyle=FormBorderStyle.None;MinimumSize=Size.Empty;close.Visible=false;status.MaximumSize=new Size(480,0);foreach(Control item in body.Controls)if(item is Label)((Label)item).MaximumSize=new Size(480,0);}UpdatePreview();
  }
  static void Add(TableLayoutPanel panel,Control control){control.Margin=new Padding(0,4,0,10);control.Anchor=AnchorStyles.Left|AnchorStyles.Right;panel.Controls.Add(control,0,panel.RowCount++);}
  void AddMessage(TableLayoutPanel body,string label,TextBox box){
    Add(body,new Label{Text=label,AutoSize=true,Dock=DockStyle.Top});
    box.Multiline=true;box.ScrollBars=ScrollBars.Vertical;box.Height=66;box.Dock=DockStyle.Top;box.MaxLength=240;box.BackColor=TrayTheme.Surface;box.ForeColor=TrayTheme.Text;Add(body,box);
    box.AccessibleName=label;Describe(box,"240자 이내로 편집합니다. 위에 표시된 치환 문자를 사용할 수 있습니다. 저장 전 예시를 참고하세요.");
  }
  void Describe(Control control,string text){control.AccessibleDescription=text;help.SetToolTip(control,text);control.Enter+=(s,e)=>status.Text=text;}
  int ReadMargin(string key){object value;if(!settings.TryGetValue(key,out value)||!(value is int))throw new InvalidDataException();int number=(int)value;if(number<1||number>100)throw new InvalidDataException();return number;}
  static string ReadMessage(Dictionary<string,object> messages,string key){object value;if(messages==null||!messages.TryGetValue(key,out value)||!(value is string)||String.IsNullOrWhiteSpace((string)value)||((string)value).Length>240)throw new InvalidDataException();return (string)value;}
  static void GuardPath(string path){
    string current=Path.GetFullPath(path);
    while(!String.IsNullOrEmpty(current)){
      if((File.Exists(current)||Directory.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new IOException("연결된 설정 경로는 보존합니다.");
      string parent=Path.GetDirectoryName(current);if(parent==current)break;current=parent;
    }
  }
  string ReadCurrent(){GuardPath(settingsPath);if(!File.Exists(settingsPath))return null;var info=new FileInfo(settingsPath);if(info.Length>16384)throw new InvalidDataException();return File.ReadAllText(settingsPath,Encoding.UTF8);}
  string PolicyValue(string key){object value;return policy!=null&&policy.TryGetValue(key,out value)?Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture):"미확인";}
  static string Render(string text,string window,string used,string limit,string margin){return text.Replace("{account}","현재 선택 계정").Replace("{window}",window).Replace("{used}",used).Replace("{limit}",limit).Replace("{remaining}",margin);}
  void UpdatePreview(){
    decimal shortLimit,longLimit;string shortText=PolicyValue("fiveHourUsedThreshold"),longText=PolicyValue("longWindowUsedThreshold");
    string shortUsed=Decimal.TryParse(shortText,System.Globalization.NumberStyles.Number,System.Globalization.CultureInfo.InvariantCulture,out shortLimit)?Math.Max(0,100-warning.Value).ToString():"미확인";
    string urgentUsed=Decimal.TryParse(shortText,System.Globalization.NumberStyles.Number,System.Globalization.CultureInfo.InvariantCulture,out shortLimit)?Math.Max(0,100-urgent.Value).ToString():"미확인";
    string weekUsed=Decimal.TryParse(longText,System.Globalization.NumberStyles.Number,System.Globalization.CultureInfo.InvariantCulture,out longLimit)?Math.Max(0,100-urgent.Value).ToString():"미확인";
    preview.Text=(!active.Checked?"전체 경고 꺼짐":("일반 "+(warningEnabled.Checked?"켜짐":"꺼짐")+" · 긴급 "+(urgentEnabled.Checked?"켜짐":"꺼짐")))+Environment.NewLine+"5시간 일반: "+Render(shortWarning.Text,"5시간",shortUsed,shortText,warning.Value.ToString())+Environment.NewLine+
      "5시간 긴급: "+Render(shortUrgent.Text,"5시간",urgentUsed,shortText,urgent.Value.ToString())+Environment.NewLine+
      "주간 긴급: "+Render(weekUrgent.Text,"주간",weekUsed,longText,urgent.Value.ToString());
    status.Text=warning.Value<=urgent.Value?"일반 기준을 긴급 기준보다 크게 설정하세요.":"잔여 10% / 6%는 사용률 90% / 94%입니다. 차단선은 별도로 유지됩니다.";
  }
  void Save(){
    if(warning.Value<=urgent.Value){status.Text="일반 기준은 긴급 기준보다 커야 합니다.";warning.Focus();return;}
    foreach(var box in new[]{shortWarning,shortUrgent,weekUrgent})if(String.IsNullOrWhiteSpace(box.Text)||box.Text.Trim().Length>240){status.Text="각 문구는 빈칸 없이 240자 이내로 입력하세요.";box.Focus();return;}
    try{
      GuardPath(settingsPath);Directory.CreateDirectory(Path.GetDirectoryName(settingsPath));GuardPath(settingsPath);
      string lockPath=settingsPath+".lock";GuardPath(lockPath);
      using(var gate=new FileStream(lockPath,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)){
        if(!String.Equals(ReadCurrent(),original,StringComparison.Ordinal)){status.Text="다른 곳에서 설정이 바뀌었습니다. 닫고 다시 열어 최신 설정을 편집하세요.";return;}
        settings["basis"]="remaining_to_100";settings["enabled"]=active.Checked;settings["warningEnabled"]=warningEnabled.Checked;settings["urgentEnabled"]=urgentEnabled.Checked;settings["warningMargin"]=Decimal.ToInt32(warning.Value);settings["urgentMargin"]=Decimal.ToInt32(urgent.Value);
        var messages=(Dictionary<string,object>)settings["messages"];
        messages["fiveHourWarning"]=shortWarning.Text.Trim();messages["fiveHourUrgent"]=shortUrgent.Text.Trim();messages["weeklyUrgent"]=weekUrgent.Text.Trim();
        string next=serializer.Serialize(settings),temporary=settingsPath+"."+Guid.NewGuid().ToString("N")+".tmp";
        using(var file=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None))using(var writer=new StreamWriter(file,new UTF8Encoding(false)))writer.Write(next);
        if(File.Exists(settingsPath))File.Replace(temporary,settingsPath,null);else File.Move(temporary,settingsPath);
        original=next;
      }
      status.Text="저장했습니다. 다음 훅 경계부터 사용합니다. 현재 실행 중인 대화의 즉시 반영은 보장하지 않습니다.";
    }catch{status.Text="저장하지 못했습니다. 파일 권한이나 다른 편집 작업을 확인한 뒤 다시 시도하세요. 기존 설정을 보존했습니다.";}
  }
  void ShowHelp(){MessageBox.Show(this,"현재 선택된 OCX 계정의 신선한 관측값만 사용합니다.\n5시간: 일반과 긴급 · 주간: 긴급만\n경고선은 100% 기준 잔여량입니다. 잔여 10% / 6%는 사용률 90% / 94%입니다. 차단선과 별개이며 차단이 먼저 오면 사전 경고가 없을 수 있습니다.\n\n대화·계정·기간별 같은 단계는 반복하지 않습니다. 일반에서 긴급으로 올라가면 추가 경고합니다. 잔여량이 경고선보다 2%p 넘게 회복된 뒤 다시 들어오면 재알림합니다. 계정이 바뀌면 그 계정을 별도로 판단합니다.\n\n전체 사용과 일반·긴급 단계를 각각 선택하고 저장하세요. 긴급 꺼짐은 긴급 구간 알림을 끄며 일반 경고로 대체하지 않습니다. 단계와 문구를 편집하고 저장하세요. Tab으로 이동, F1은 사용법, Esc는 닫기입니다. 저장은 다음 훅 경계부터 적용되며 이미 추론 중인 작업에는 늦을 수 있습니다. 선택 풀 계정이 각 대화의 실제 요청 계정이라는 증명은 아닙니다.","OCX 사전 경고 사용법",MessageBoxButtons.OK,MessageBoxIcon.Information);}
  protected override void Dispose(bool disposing){if(disposing)help.Dispose();base.Dispose(disposing);if(disposing)ownedFont.Dispose();}
}
internal sealed class DarkTrayMenuRenderer : ToolStripProfessionalRenderer {internal DarkTrayMenuRenderer():base(new DarkTrayMenuColors()){RoundedEdges=false;}}
internal sealed class DarkTrayMenuColors : ProfessionalColorTable {
  public override Color ToolStripDropDownBackground{get{return TrayTheme.Surface;}}
  public override Color ImageMarginGradientBegin{get{return ToolStripDropDownBackground;}}
  public override Color ImageMarginGradientMiddle{get{return ToolStripDropDownBackground;}}
  public override Color ImageMarginGradientEnd{get{return ToolStripDropDownBackground;}}
  public override Color MenuItemSelected{get{return TrayTheme.Dark?Color.FromArgb(62,62,62):Color.FromArgb(235,235,235);}}
  public override Color MenuItemBorder{get{return TrayTheme.Accent;}}
}

internal static class AiccStatusTray {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [STAThread] static int Main(string[] args){
    if(args.Length<2||!File.Exists(args[0])||!File.Exists(args[1]))return 2;
    try{if(!SetProcessDpiAwarenessContext(new IntPtr(-4)))SetProcessDPIAware();}catch(EntryPointNotFoundException){SetProcessDPIAware();}
    Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
    if(args.Length==5&&args[2]=="--operations-preview"){
      try{
        string helper=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"tools","platform","windows","Invoke-AiccTroubleshooter.ps1");
        string shell=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center","toolchain","pwsh-7.6.6","runtime","pwsh.exe");
        using(var dialog=new AiccOperationsDialog(args[3]=="rdc",helper,shell)){
          dialog.StartPosition=FormStartPosition.Manual;dialog.Location=new Point(-32000,-32000);
          var timer=new System.Windows.Forms.Timer{Interval=12000};timer.Tick+=(s,e)=>{timer.Stop();using(var bitmap=new Bitmap(dialog.Width,dialog.Height)){dialog.DrawToBitmap(bitmap,new Rectangle(0,0,dialog.Width,dialog.Height));bitmap.Save(args[4]);}dialog.Close();};
          timer.Start();Application.Run(dialog);timer.Dispose();
        }return 0;
      }catch(Exception failure){File.WriteAllText(args[4]+".failure.txt",failure.Message);return 4;}
    }
    if((args.Length==4||args.Length==5||args.Length==6)&&args[2]=="--preview"){
      try{using(var popup=new StatusPopup()){
        using(var p=Process.Start(new ProcessStartInfo(args[0],"\""+args[1]+"\" --cached"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,StandardOutputEncoding=System.Text.Encoding.UTF8})){
          var read=p.StandardOutput.ReadToEndAsync();if(!p.WaitForExit(90000))return 3;
          popup.Data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(read.Result);
        }
        popup.RenderState();if(args.Length>=5)popup.SelectPreviewPage(Int32.Parse(args[4]));popup.PreviewNoActivate=true;popup.StartPosition=FormStartPosition.Manual;popup.Location=new Point(-32000,-32000);popup.Show();Application.DoEvents();if(args.Length==6&&args[5]=="--stress-transparency")popup.StressTransparency(100);else if(args.Length==6&&args[5]=="--stress-menus")popup.StressMenuLifecycle(120);else if(args.Length==6&&args[5]=="--stress-navigation"){popup.StressNavigation(120);popup.SelectPreviewPage(Int32.Parse(args[4]));}else if(args.Length==6&&args[5]=="--exercise-ui")popup.ExerciseUi(args[3]+".json");else if(args.Length==6&&args[5]=="--preview-credits")popup.PreviewCreditInventory();using(var bitmap=new Bitmap(popup.Width,popup.Height)){popup.DrawToBitmap(bitmap,new Rectangle(0,0,popup.Width,popup.Height));bitmap.Save(args[3]);}
      }return 0;}catch(Exception failure){File.WriteAllText(args[3]+".failure.txt",failure.Message);return 4;}
    }
    bool fresh;using(var mutex=new Mutex(true,"Local\\AiccStatusTray-"+System.Security.Principal.WindowsIdentity.GetCurrent().User.Value,out fresh)){
      if(!fresh)return 0;using(var ctx=new TrayContext(args[0],args[1])){Application.Run(ctx);}mutex.ReleaseMutex();
    }return 0;
  }
}
