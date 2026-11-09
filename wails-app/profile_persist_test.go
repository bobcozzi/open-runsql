package main

import "testing"

func withTempStore(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
}

func TestAutoSavePreservesName(t *testing.T) {
	withTempStore(t)
	a := &App{}
	if err := a.UpdateConnectionProfile("", ConnectionProfile{Name: "AID - NAS", Host: "1.2.3.4", User: "cozzi"}); err != nil {
		t.Fatal(err)
	}
	// Connect-panel auto-save: name = host, no password save.
	if err := a.SaveConnectionProfile(ConnectionProfile{Name: "1.2.3.4", Host: "1.2.3.4", User: "cozzi"}); err != nil {
		t.Fatal(err)
	}
	got, _ := a.ListConnectionProfiles()
	if len(got) != 1 || got[0].Name != "AID - NAS" {
		t.Fatalf("name lost: %+v", got)
	}
}

func TestUpdateNeverCollapsesNameToHost(t *testing.T) {
	withTempStore(t)
	a := &App{}
	if err := a.UpdateConnectionProfile("", ConnectionProfile{Name: "AID - NAS", Host: "1.2.3.4", User: "cozzi"}); err != nil {
		t.Fatal(err)
	}
	// Caller passed name=host (form rebuild) — must not clobber.
	if err := a.UpdateConnectionProfile("AID - NAS", ConnectionProfile{Name: "1.2.3.4", Host: "1.2.3.4", User: "cozzi", Script: "select 1"}); err != nil {
		t.Fatal(err)
	}
	got, _ := a.ListConnectionProfiles()
	if len(got) != 1 || got[0].Name != "AID - NAS" || got[0].Script != "select 1" {
		t.Fatalf("bad state: %+v", got)
	}
}
