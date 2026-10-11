"""Dependency-free observation of the owned ML process; no model imports."""
import ctypes
import json
import os
import sys
import threading
import time


def sample(pid):
    if os.name == "nt":
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in
                ("peak", "rss", "qpp", "pp", "qpn", "pn", "page", "peakpage")]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        handle = kernel.OpenProcess(0x0400 | 0x0010, False, pid)
        if not handle:
            raise OSError(ctypes.get_last_error(), "OpenProcess")
        try:
            creation, exit_time, system, user = [wintypes.FILETIME() for _ in range(4)]
            if not kernel.GetProcessTimes(handle, *[ctypes.byref(x) for x in (creation, exit_time, system, user)]):
                raise OSError("GetProcessTimes")
            seconds = lambda x: ((x.dwHighDateTime << 32) | x.dwLowDateTime) / 1e7
            memory = Counters()
            memory.cb = ctypes.sizeof(memory)
            if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
                raise OSError("GetProcessMemoryInfo")
            return {"cpuSeconds": seconds(system) + seconds(user), "rssBytes": memory.rss}
        finally:
            kernel.CloseHandle(handle)
    if sys.platform.startswith("linux"):
        with open(f"/proc/{pid}/stat", encoding="utf8") as source:
            fields = source.read().rsplit(")", 1)[1].split()
        return {"cpuSeconds": (int(fields[11]) + int(fields[12])) / os.sysconf("SC_CLK_TCK"),
                "rssBytes": int(fields[21]) * os.sysconf("SC_PAGE_SIZE")}
    raise OSError("ML process sampling unsupported on this OS")


def main():
    pids = sorted(set(int(value) for value in sys.argv[1].split(',')))
    stop = threading.Event()
    threading.Thread(target=lambda: (sys.stdin.readline(), stop.set()), daemon=True).start()
    while True:
        try:
            processes = [{"pid": pid, **sample(pid)} for pid in pids]
            row = {"epochMs": time.time_ns() / 1e6, "processes": processes,
                   "cpuSeconds": sum(p["cpuSeconds"] for p in processes),
                   "rssBytes": sum(p["rssBytes"] for p in processes)}
        except OSError as error:
            row = {"epochMs": time.time_ns() / 1e6, "pids": pids, "error": str(error)}
        print(json.dumps(row), flush=True)
        if stop.is_set():
            break
        stop.wait(1)


if __name__ == "__main__":
    main()
