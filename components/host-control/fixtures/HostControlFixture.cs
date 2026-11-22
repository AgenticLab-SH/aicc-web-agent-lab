using System;
using System.Drawing;
using System.Windows.Forms;
public class AiccHostControlFixture : Form {
 [STAThread] public static void Main() { Application.EnableVisualStyles(); Application.Run(new AiccHostControlFixture()); }
 public AiccHostControlFixture() {
  Text="AICC Host Control Test"; ClientSize=new Size(420,170); StartPosition=FormStartPosition.Manual; Location=new Point(50,80);
  var prompt=new Label{Text="AICC test only - no user files",Left=20,Top=15,Width=370};
  var input=new TextBox{Name="TestInput",AccessibleName="Test input",Left=20,Top=45,Width=370};
  var state=new Label{Name="Result",Text="Ready",Left=20,Top=85,Width=370};
  var apply=new Button{Name="Apply",AccessibleName="Apply test",Text="Apply test",Left=20,Top=120,Width=130};
  apply.Click+=(sender,args)=>{state.Text="Verified: "+input.Text;};
  var close=new Button{Name="Close",AccessibleName="Close test",Text="Close test",Left=260,Top=120,Width=130};
  close.Click+=(sender,args)=>Close(); Controls.AddRange(new Control[]{prompt,input,state,apply,close});
 }
}

