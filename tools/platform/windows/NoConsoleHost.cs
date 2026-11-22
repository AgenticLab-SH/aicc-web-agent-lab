using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

// GUI subsystem: no console is allocated, including on Windows Terminal hosts.
internal static class NoConsoleHost {
  static IntPtr job;
  [StructLayout(LayoutKind.Sequential)] struct Basic {public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinWorkingSet,MaxWorkingSet;public uint ActiveProcessLimit;public UIntPtr Affinity;public uint Priority,Scheduling;}
  [StructLayout(LayoutKind.Sequential)] struct Io {public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;}
  [StructLayout(LayoutKind.Sequential)] struct Extended {public Basic Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr handle,int kind,ref Extended info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr handle,IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static void Initialize(){
    job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new System.ComponentModel.Win32Exception();
    var info=new Extended();info.Basic.Flags=0x2000;
    if(!SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf(typeof(Extended)))||!AssignProcessToJobObject(job,GetCurrentProcess()))throw new System.ComponentModel.Win32Exception();
  }
  static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
  [STAThread] static int Main(string[] args) {
    try {
      Initialize();
      string shell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
      var start = new ProcessStartInfo(shell, string.Join(" ", args.Select(Quote).ToArray()));
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      start.WindowStyle = ProcessWindowStyle.Hidden;
      using (var child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
    } catch { return 1; }
  }
}
