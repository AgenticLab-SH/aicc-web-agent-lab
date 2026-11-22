# Keep the task's entire child tree in a kernel-owned lifetime boundary.
# The non-inherited handle stays open until this launcher exits.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AiccWorkspaceProcessJob {
  static IntPtr job;
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Initialize() {
    if(job!=IntPtr.Zero) return;
    var handle=CreateJobObject(IntPtr.Zero,null);
    if(handle==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    var info=new Extended();info.Basic.Flags=0x2000;
    if(!SetInformationJobObject(handle,9,ref info,(uint)Marshal.SizeOf(typeof(Extended)))) {
      var error=Marshal.GetLastWin32Error();CloseHandle(handle);throw new System.ComponentModel.Win32Exception(error);
    }
    if(!AssignProcessToJobObject(handle,GetCurrentProcess())) {
      var error=Marshal.GetLastWin32Error();CloseHandle(handle);throw new System.ComponentModel.Win32Exception(error);
    }
    job=handle;
  }
}
'@
[AiccWorkspaceProcessJob]::Initialize()
