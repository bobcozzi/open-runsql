package main

import (
	"sync"
)

// WorkspaceState is the per-connection workspace, owned by Go so that any
// window (main or torn-off) renders from the same source of truth. The
// frontend mirrors this via the "workspace:changed" event.
type WorkspaceState struct {
	ConnectionID   string       `json:"connectionId"`
	Label          string       `json:"label"`
	EditorText     string       `json:"editorText"`
	Columns        []ColumnInfo `json:"columns"`
	Rows           [][]any      `json:"rows"`
	CursorID       string       `json:"cursorId,omitempty"`
	More           bool         `json:"more"`
	StatusText     string       `json:"statusText"`
	MessagesHTML   string       `json:"messagesHtml"`
	ShowingResults bool         `json:"showingResults"`
}

// WorkspaceStore holds workspace state per connection and emits change events.
type WorkspaceStore struct {
	mu     sync.RWMutex
	app    *App
	states map[string]*WorkspaceState // keyed by connectionId
	order  []string                   // connection order for listing
}

func NewWorkspaceStore(app *App) *WorkspaceStore {
	return &WorkspaceStore{app: app, states: map[string]*WorkspaceState{}}
}

func (s *WorkspaceStore) forConn(connID string) *WorkspaceState {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.states[connID]
	if !ok {
		st = &WorkspaceState{ConnectionID: connID}
		s.states[connID] = st
		s.order = append(s.order, connID)
	}
	return st
}

func (s *WorkspaceStore) remove(connID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.states, connID)
	out := s.order[:0]
	for _, id := range s.order {
		if id != connID {
			out = append(out, id)
		}
	}
	s.order = out
}

// emitChanged pushes the current state for a connection to all windows.
func (s *WorkspaceStore) emitChanged(connID string) {
	if s.app.app == nil {
		return
	}
	s.mu.RLock()
	st := s.states[connID]
	s.mu.RUnlock()
	if st == nil {
		return
	}
	s.app.app.Event.Emit("workspace:changed:"+connID, *st)
}

// Update merges a partial update and notifies subscribers.
func (s *WorkspaceStore) Update(connID string, mutate func(*WorkspaceState)) {
	s.mu.Lock()
	mutate(s.forConnLocked(connID))
	s.mu.Unlock()
	s.emitChanged(connID)
}

// forConnLocked is forConn without locking (caller holds s.mu).
func (s *WorkspaceStore) forConnLocked(connID string) *WorkspaceState {
	st, ok := s.states[connID]
	if !ok {
		st = &WorkspaceState{ConnectionID: connID}
		s.states[connID] = st
		s.order = append(s.order, connID)
	}
	return st
}

// GetWorkspace returns a copy of the workspace state for a connection.
func (s *WorkspaceStore) GetWorkspace(connID string) WorkspaceState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if st, ok := s.states[connID]; ok {
		return *st
	}
	return WorkspaceState{ConnectionID: connID}
}

// ListWorkspaces returns all workspace states in connection order.
func (s *WorkspaceStore) ListWorkspaces() []WorkspaceState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]WorkspaceState, 0, len(s.order))
	for _, id := range s.order {
		out = append(out, *s.states[id])
	}
	return out
}
