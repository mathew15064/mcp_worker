//go:build windows

package main

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

var globalMemoryStatusExProc = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

func platformMemorySnapshot() (memorySnapshot, error) {
	status := memoryStatusEx{}
	status.Length = uint32(unsafe.Sizeof(status))
	result, _, callErr := globalMemoryStatusExProc.Call(uintptr(unsafe.Pointer(&status)))
	if result == 0 {
		return memorySnapshot{}, fmt.Errorf("GlobalMemoryStatusEx failed: %v", callErr)
	}
	if status.TotalPhys == 0 {
		return memorySnapshot{}, fmt.Errorf("physical memory total is unavailable")
	}
	return memorySnapshot{TotalBytes: status.TotalPhys, AvailableBytes: status.AvailPhys}, nil
}
