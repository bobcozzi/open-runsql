package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestSQLCompletionsForwardWithoutStateChanges(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	app := NewApp("")
	state := &connState{id: "conn", cursorID: "cursor", hasCursor: true}
	app.connections["conn"] = state
	app.workspace.Update("conn", func(workspace *WorkspaceState) {
		workspace.EditorText = "select edited_but_not_executed from example"
		workspace.InitialEditorText = "select original from example"
		workspace.CursorID = "cursor"
		workspace.More = true
		workspace.Rows = [][]any{{"existing result"}}
		workspace.ResultStatement = "select original from example"
		workspace.ShowingResults = true
	})
	before := app.workspace.ListWorkspaces()
	bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
		want := map[string]any{"connectionId": "conn", "kind": "parameters", "schema": "Mixed Schema", "object": "Routine", "prefix": "a_%"}
		if op != "sqlCompletions" || !reflect.DeepEqual(fields, want) {
			t.Fatalf("op=%s fields=%v", op, fields)
		}
		return map[string]any{"result": []any{map[string]any{"name": "arg", "kind": "parameters", "detail": "IN INTEGER", "specificName": "overload"}}}, nil
	}}
	app.client = bridge
	state.opMu.Lock()
	defer state.opMu.Unlock()
	rows, err := app.GetSQLCompletions("conn", "parameters", "Mixed Schema", "Routine", "a_%")
	if err != nil || len(rows) != 1 || rows[0].SpecificName != "overload" {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
	after := app.workspace.ListWorkspaces()
	if state.cursorID != "cursor" || !state.hasCursor || !reflect.DeepEqual(before, after) || len(bridge.calls) != 1 {
		t.Fatal("completion changed cursor/workspace or made extra calls")
	}
}

func TestSQLCompletionsRejectInvalidInputsAndResponses(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	app := NewApp("")
	app.connections["conn"] = &connState{id: "conn"}
	bridge := &fakeEnhancedBridge{handle: func(string, map[string]any) (map[string]any, error) {
		return nil, errors.New("bridge failure")
	}}
	app.client = bridge
	for _, args := range [][4]string{{"bogus", "LIB", "", ""}, {"tables", "", "", ""}, {"columns", "LIB", "", ""}, {"tables", "LIB", "", strings.Repeat("x", 129)}, {"tables", "LIB\x00", "", ""}} {
		if _, err := app.GetSQLCompletions("conn", args[0], args[1], args[2], args[3]); err == nil {
			t.Fatalf("accepted %q", args)
		}
	}
	if len(bridge.calls) != 0 {
		t.Fatal("invalid inputs reached bridge")
	}
	if _, err := app.GetSQLCompletions("missing", "tables", "LIB", "", ""); err == nil || len(bridge.calls) != 0 {
		t.Fatal("unknown connection reached bridge")
	}
	if _, err := app.GetSQLCompletions("conn", "tables", "LIB", "", ""); err == nil {
		t.Fatal("bridge error lost")
	}
	for _, result := range []any{nil, "bad", []any{42}, []any{map[string]any{"name": 42, "kind": "tables", "detail": ""}}, []any{map[string]any{"name": "a", "kind": "tables", "detail": "", "specificName": false}}, make([]any, 201)} {
		bridge.handle = func(string, map[string]any) (map[string]any, error) { return map[string]any{"result": result}, nil }
		if _, err := app.GetSQLCompletions("conn", "tables", "LIB", "", ""); err == nil {
			t.Fatalf("accepted response %#v", result)
		}
	}
	bridge.handle = func(string, map[string]any) (map[string]any, error) { return map[string]any{"result": []any{}}, nil }
	if rows, err := app.GetSQLCompletions("conn", "tables", "LIB", "", ""); err != nil || rows == nil || len(rows) != 0 {
		t.Fatalf("empty result=%v err=%v", rows, err)
	}
}
