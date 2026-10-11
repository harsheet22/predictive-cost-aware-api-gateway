# Read-only helper. No trace start/stop, elevation or service operations.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class GatewayEtwProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Wnode {
    public uint BufferSize, ProviderId; public ulong HistoricalContext; public long TimeStamp;
    public Guid Guid; public uint ClientContext, Flags;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Properties {
    public Wnode Wnode; public uint BufferSize, MinimumBuffers, MaximumBuffers, MaximumFileSize,
      LogFileMode, FlushTimer, EnableFlags; public int AgeLimit;
    public uint NumberOfBuffers, FreeBuffers, EventsLost, BuffersWritten, LogBuffersLost, RealTimeBuffersLost;
    public IntPtr LoggerThreadId; public uint LogFileNameOffset, LoggerNameOffset;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
  static extern uint QueryAllTracesW([In,Out] IntPtr[] properties, uint count, out uint actual);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetVolumePathNameW(string path, StringBuilder volume, uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetDiskFreeSpaceExW(string path, out ulong available, out ulong total, out ulong free);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string path);
  public static object Disk(string path) {
    var volume=new StringBuilder(1024);
    if(!GetVolumePathNameW(path,volume,(uint)volume.Capacity)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if(GetDriveTypeW(volume.ToString())!=3) throw new Exception("Output must be on a local fixed volume");
    ulong available,total,free;
    if(!GetDiskFreeSpaceExW(path,out available,out total,out free)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return new { freeBytes=available, volume=volume.ToString(), localFixed=true };
  }
  public static object[] Sessions() {
    int header = Marshal.SizeOf(typeof(Properties)), size = header + 8192;
    var pointers = new IntPtr[256]; var result = new List<object>();
    try {
      for (int i=0;i<pointers.Length;i++) {
        pointers[i] = Marshal.AllocHGlobal(size);
        Marshal.Copy(new byte[size],0,pointers[i],size);
        var p = new Properties(); p.Wnode.BufferSize=(uint)size;
        p.LoggerNameOffset=(uint)header; p.LogFileNameOffset=(uint)(header+4096);
        Marshal.StructureToPtr(p,pointers[i],false);
      }
      uint count; uint status=QueryAllTracesW(pointers,(uint)pointers.Length,out count);
      if(status!=0 || count>pointers.Length) throw new Exception("Incomplete ETW session query: "+status);
      for(int i=0;i<count;i++) {
        var p=(Properties)Marshal.PtrToStructure(pointers[i],typeof(Properties));
        if(p.LoggerNameOffset<header || p.LoggerNameOffset>=size || (p.LogFileNameOffset!=0 && (p.LogFileNameOffset<header || p.LogFileNameOffset>=size))) throw new Exception("Invalid ETW string offsets");
        result.Add(new { name=Marshal.PtrToStringUni(IntPtr.Add(pointers[i],(int)p.LoggerNameOffset)),
          file=p.LogFileNameOffset==0 ? "" : Marshal.PtrToStringUni(IntPtr.Add(pointers[i],(int)p.LogFileNameOffset)),
          handle=p.Wnode.HistoricalContext.ToString(), guid=p.Wnode.Guid.ToString(),
          eventsLost=p.EventsLost, logBuffersLost=p.LogBuffersLost, realTimeBuffersLost=p.RealTimeBuffersLost });
      }
      return result.ToArray();
    } finally { foreach(var pointer in pointers) if(pointer!=IntPtr.Zero) Marshal.FreeHGlobal(pointer); }
  }
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    switch ($request.action) {
      'sessions' { $data = @{ sessions = @([GatewayEtwProbe]::Sessions()) } }
      'disk' { $data = [GatewayEtwProbe]::Disk([IO.Path]::GetFullPath($request.path)) }
      'permissions' {
        $item = Get-Item -LiteralPath $request.path -Force
        if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsupported output directory' }
        $acl = Get-Acl -LiteralPath $request.path
        $sidType = [Security.Principal.SecurityIdentifier]
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
        $owner = $acl.GetOwner($sidType).Value
        $rules = @($acl.GetAccessRules($true,$true,$sidType) | ForEach-Object {
          @{ sid=$_.IdentityReference.Value; type=$_.AccessControlType.ToString(); rights=$_.FileSystemRights.ToString(); inherited=$_.IsInherited; inheritance=$_.InheritanceFlags.ToString() }
        })
        $unsafe = @($rules | Where-Object { $_.type -ne 'Allow' -or $_.sid -notin $allowed })
        $full = @($rules | Where-Object { $_.sid -eq $sid -and $_.type -eq 'Allow' -and $_.rights -match 'FullControl' -and $_.inheritance -match 'ContainerInherit' -and $_.inheritance -match 'ObjectInherit' })
        $data = @{ private=($owner -in $allowed -and $rules.Count -gt 0 -and $unsafe.Count -eq 0 -and $full.Count -gt 0); ownerSid=$owner; rules=$rules }
      }
      default { throw 'Unknown read-only probe action' }
    }
    @{ id = $request.id; data = $data } | ConvertTo-Json -Depth 6 -Compress | ForEach-Object { [Console]::WriteLine($_) }
  } catch {
    @{ id = $request.id; error = $_.Exception.Message } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
  }
}
