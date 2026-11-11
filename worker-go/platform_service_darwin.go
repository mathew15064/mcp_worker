//go:build darwin

package main

func platformStartManagedService() error {
	return fail("WORKER_SERVICE_UNSUPPORTED", "Managed system service startup is not enabled for this macOS build yet; run systemtd start after login.")
}

func platformRestartManagedService() error {
	return fail("WORKER_SERVICE_UNSUPPORTED", "Managed service restart is not enabled for this build yet.")
}
