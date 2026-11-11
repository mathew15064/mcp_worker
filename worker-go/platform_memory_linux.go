//go:build linux

package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func platformMemorySnapshot() (memorySnapshot, error) {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return memorySnapshot{}, err
	}
	defer file.Close()
	values := map[string]uint64{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		value, parseErr := strconv.ParseUint(fields[1], 10, 64)
		if parseErr != nil {
			continue
		}
		values[key] = value * 1024
	}
	if err := scanner.Err(); err != nil {
		return memorySnapshot{}, err
	}
	total := values["MemTotal"]
	available := values["MemAvailable"]
	if available == 0 {
		available = values["MemFree"] + values["Buffers"] + values["Cached"] + values["SReclaimable"]
	}
	if total == 0 {
		return memorySnapshot{}, fmt.Errorf("MemTotal is unavailable")
	}
	return memorySnapshot{TotalBytes: total, AvailableBytes: available}, nil
}
