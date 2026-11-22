using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
internal static class AiccComponentLauncher {
  static string Quote(string value){var text=new StringBuilder("\"");int slashes=0;foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"')text.Append('\\',slashes*2+1);else text.Append('\\',slashes);text.Append(c);slashes=0;}text.Append('\\',slashes*2);text.Append('"');return text.ToString();}
  [STAThread] static int Main(string[] args){
    try{
      string home=Environment.GetEnvironmentVariable("AICC_STATE_ROOT");if(String.IsNullOrWhiteSpace(home))home=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-control-center");home=Path.GetFullPath(home);
      string registry=Path.Combine(home,"runtime","components.json");
      var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(registry));
      if(Convert.ToInt32(data["schemaVersion"])!=1||!String.Equals(Path.GetFullPath(Convert.ToString(data["root"])),home,StringComparison.OrdinalIgnoreCase))return 2;
      string name=args.Length==0?"tray":args[0];if(name!="tray")return 2;
      var component=(Dictionary<string,object>)((Dictionary<string,object>)data["components"])[name];
      string exe=Path.GetFullPath(Convert.ToString(component["entry"]));string releases=Path.Combine(home,"releases")+Path.DirectorySeparatorChar;
      if(!exe.StartsWith(releases,StringComparison.OrdinalIgnoreCase)||!File.Exists(exe)||(File.GetAttributes(exe)&FileAttributes.ReparsePoint)!=0)return 2;
      var argv=new List<string>();foreach(object value in (IEnumerable)component["arguments"])argv.Add(Quote(Convert.ToString(value)));
      Process.Start(new ProcessStartInfo(exe,String.Join(" ",argv.ToArray())){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=Path.GetDirectoryName(exe)});return 0;
    }catch{return 2;}
  }
}
