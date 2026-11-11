//go:build darwin

package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

func platformMemorySnapshot() (memorySnapshot, error) {
	totalOut, err := exec.Command("/usr/sbin/sysctl", "-n", "hw.memsize").Output()
	if err != nil {
		return memorySnapshot{}, err
	}
	total, err := strconv.ParseUint(strings.TrimSpace(string(totalOut)), 10, 64)
	if err != nil || total == 0 {
		return memorySnapshot{}, fmt.Errorf("invalid hw.memsize")
	}
	vmOut, err := exec.Command("/usr/bin/vm_stat").Output()
	if err != nil {
		return memorySnapshot{}, err
	}
	pageSize := uint64(4096)
	availablePages := uint64(0)
	for index, line := range strings.Split(string(vmOut), "\n") {
		line = strings.TrimSpace(line)
		if index == 0 {
			if start := strings.Index(line, "page size of "); start >= 0 {
				rest := line[start+len("page size of "):]
				if end := strings.Index(rest, " bytes"); end > 0 {
					if parsed, parseErr := strconv.ParseUint(strings.TrimSpace(rest[:end]), 10, 64); parseErr == nil && parsed > 0 {
						pageSize = parsed
					}
				}
			}
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		valueText := strings.TrimSpace(strings.TrimSuffix(parts[1], "."))
		value, parseErr := strconv.ParseUint(valueText, 10, 64)
		if parseErr != nil {
			continue
		}
		switch key {
		case "Pages free", "Pages inactive", "Pages speculative", "Pages purgeable":
			availablePages += value
		}
	}
	available := availablePages * pageSize
	if available > total {
		available = total
	}
	return memorySnapshot{TotalBytes: total, AvailableBytes: available}, nil
}
