package main

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
)

// WindowManager abstracts tear-off window creation. The v2 implementation
// spawns a detached child process (--window=<connectionId>); the Wails v3
// implementation swaps this to in-process app.NewWindow() with no caller
// change. Callers only see OpenDetached / CloseDetached / ListDetached.
type WindowManager interface {
	OpenDetached(connectionID, title string) error
	CloseDetached(connectionID string) error
	ListDetached() []string
}

// processWindowManager is the Wails v2 implementation: one child process per
// detached window, sharing this process's workspace state via the Go store
// only through the bind (state stays in this process; the child renders
// read-only via GetWorkspace + workspace:changed events over its own window).
type processWindowManager struct {
	mu       sync.Mutex
	children map[string]*exec.Cmd // connectionId -> child process
	exePath  string
}

func NewWindowManager() (WindowManager, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return &processWindowManager{children: map[string]*exec.Cmd{}, exePath: exe}, nil
}

func (m *processWindowManager) OpenDetached(connectionID, title string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, running := m.children[connectionID]; running {
		return fmt.Errorf("connection already detached")
	}
	cmd := exec.Command(m.exePath, "--window="+connectionID, "--title="+title)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	m.children[connectionID] = cmd
	go func() {
		_ = cmd.Wait()
		m.mu.Lock()
		delete(m.children, connectionID)
		m.mu.Unlock()
	}()
	return nil
}

func (m *processWindowManager) CloseDetached(connectionID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cmd, ok := m.children[connectionID]
	if !ok {
		return nil
	}
	_ = cmd.Process.Kill()
	delete(m.children, connectionID)
	return nil
}

func (m *processWindowManager) ListDetached() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.children))
	for id := range m.children {
		out = append(out, id)
	}
	return out
}
