package main

import (
	"sync"
	"testing"
)

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

func TestSessionScriptDoesNotOverwriteStartupScript(t *testing.T) {
	withTempStore(t)
	app := &App{}
	enabled := true
	profile := ConnectionProfile{Name: "test", Host: "example", User: "user", Script: "startup", SaveScript: &enabled}
	if err := app.UpdateConnectionProfile("", profile); err != nil {
		t.Fatal(err)
	}
	if err := app.SaveConnectionSessionScript("EXAMPLE", "USER", "last session"); err != nil {
		t.Fatal(err)
	}
	if err := app.SaveConnectionProfile(ConnectionProfile{Name: "example", Host: "example", User: "user"}); err != nil {
		t.Fatal(err)
	}
	profile.Script = "edited startup"
	if err := app.UpdateConnectionProfile("test", profile); err != nil {
		t.Fatal(err)
	}
	got, err := app.ListConnectionProfiles()
	if err != nil || len(got) != 1 || got[0].Script != "edited startup" || got[0].SessionScript != "last session" || got[0].SaveScript == nil || !*got[0].SaveScript {
		t.Fatalf("scripts not preserved: %+v, err=%v", got, err)
	}
	disabled := false
	profile.SaveScript = &disabled
	if err := app.UpdateConnectionProfile("test", profile); err != nil {
		t.Fatal(err)
	}
	if err := app.SaveConnectionSessionScript("example", "user", "should not save"); err != nil {
		t.Fatal(err)
	}
	got, err = app.ListConnectionProfiles()
	if err != nil || len(got) != 1 || got[0].SessionScript != "last session" {
		t.Fatalf("disabled auto-save changed session script: %+v, err=%v", got, err)
	}
}

func TestConcurrentStartupAndSessionSaves(t *testing.T) {
	withTempStore(t)
	app := &App{}
	profile := ConnectionProfile{Name: "test", Host: "example", User: "user", Script: "startup"}
	if err := app.UpdateConnectionProfile("", profile); err != nil {
		t.Fatal(err)
	}
	profile.Script = "updated startup"
	var group sync.WaitGroup
	errors := make(chan error, 2)
	group.Add(2)
	go func() {
		defer group.Done()
		errors <- app.UpdateConnectionProfile("test", profile)
	}()
	go func() {
		defer group.Done()
		errors <- app.SaveConnectionSessionScript("example", "user", "last session")
	}()
	group.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	got, err := app.ListConnectionProfiles()
	if err != nil || len(got) != 1 || got[0].Script != "updated startup" || got[0].SessionScript != "last session" {
		t.Fatalf("concurrent saves lost data: %+v, err=%v", got, err)
	}
}
