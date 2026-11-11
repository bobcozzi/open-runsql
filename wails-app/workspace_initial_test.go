package main

import "testing"

func TestInitialEditorTextSurvivesEdits(t *testing.T) {
	app := &App{}
	app.workspace = NewWorkspaceStore(app)
	app.SetInitialEditorText("first", "initial script")
	app.SetInitialEditorText("second", "other script")
	app.UpdateEditorText("first", "edited script")
	first := app.GetWorkspace("first")
	second := app.GetWorkspace("second")
	if first.InitialEditorText != "initial script" || first.EditorText != "edited script" {
		t.Fatalf("first workspace = %+v", first)
	}
	if second.InitialEditorText != "other script" || second.EditorText != "other script" {
		t.Fatalf("second workspace = %+v", second)
	}
}
