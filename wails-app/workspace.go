package main

import (
	"sync"
)

// PinnedResult is a frozen, retained result set the user pinned in the
// Results pane. Static snapshot — never re-queried.
type PinnedResult struct {
	ID      string       `json:"id"`
	Label   string       `json:"label"`
	Columns []ColumnInfo `json:"columns"`
	Rows    [][]any      `json:"rows"`
	// SQL is the statement that produced the set (shown in the pop-out window).
	SQL string `json:"sql,omitempty"`
}

// WorkspaceState is the per-connection workspace, owned by Go so that any
// window (main or torn-off) renders from the same source of truth. The
// frontend mirrors this via the "workspace:changed" event.
type WorkspaceState struct {
	ConnectionID      string         `json:"connectionId"`
	Label             string         `json:"label"`
	EditorText        string         `json:"editorText"`
	InitialEditorText string         `json:"initialEditorText"`
	Columns           []ColumnInfo   `json:"columns"`
	Rows              [][]any        `json:"rows"`
	CursorID          string         `json:"cursorId,omitempty"`
	More              bool           `json:"more"`
	StatusText        string         `json:"statusText"`
	MessagesHTML      string         `json:"messagesHtml"`
	ShowingResults    bool           `json:"showingResults"`
	ResultStatement   string         `json:"resultStatement,omitempty"`
	PinnedResults     []PinnedResult `json:"pinnedResults,omitempty"`
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
	if st == nil {
		s.mu.RUnlock()
		return
	}
	snapshot := cloneWorkspace(st)
	s.mu.RUnlock()
	s.app.app.Event.Emit("workspace:changed:"+connID, snapshot)
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

// cloneWorkspace deep-copies a WorkspaceState so readers never share slice
// backing arrays with concurrent writers (UpdatePinnedResults/Run append to
// PinnedResults/Rows under Lock; GetWorkspace reads under RLock — a shallow
// struct copy would race). Call with s.mu held (read or write).
func cloneWorkspace(st *WorkspaceState) WorkspaceState {
	out := *st
	if st.Rows != nil {
		out.Rows = make([][]any, len(st.Rows))
		for i, r := range st.Rows {
			nr := make([]any, len(r))
			copy(nr, r)
			out.Rows[i] = nr
		}
	}
	if st.Columns != nil {
		out.Columns = make([]ColumnInfo, len(st.Columns))
		copy(out.Columns, st.Columns)
	}
	if st.PinnedResults != nil {
		out.PinnedResults = make([]PinnedResult, len(st.PinnedResults))
		for i, p := range st.PinnedResults {
			np := p
			np.Columns = make([]ColumnInfo, len(p.Columns))
			copy(np.Columns, p.Columns)
			np.Rows = make([][]any, len(p.Rows))
			for j, r := range p.Rows {
				nr := make([]any, len(r))
				copy(nr, r)
				np.Rows[j] = nr
			}
			out.PinnedResults[i] = np
		}
	}
	return out
}

// GetWorkspace returns a copy of the workspace state for a connection.
func (s *WorkspaceStore) GetWorkspace(connID string) WorkspaceState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if st, ok := s.states[connID]; ok {
		return cloneWorkspace(st)
	}
	return WorkspaceState{ConnectionID: connID}
}

// ListWorkspaces returns all workspace states in connection order.
func (s *WorkspaceStore) ListWorkspaces() []WorkspaceState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]WorkspaceState, 0, len(s.order))
	for _, id := range s.order {
		out = append(out, cloneWorkspace(s.states[id]))
	}
	return out
}
