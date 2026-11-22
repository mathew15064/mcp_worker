//go:build windows

package main

func platformStartManagedService() error {
	return fail("WORKER_SERVICE_UNSUPPORTED", "Managed Windows Service startup is not enabled for this build yet; run worker_mcp start after login.")
}

func platformRestartManagedService() error {
	return fail("WORKER_SERVICE_UNSUPPORTED", "Managed service restart is not enabled for this build yet.")
}

func platformManageService(action string) error {
	return fail("WORKER_SERVICE_UNSUPPORTED", "systemd-managed Worker services are supported on Linux only.")
}
