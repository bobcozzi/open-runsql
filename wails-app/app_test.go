package main

import "testing"

func TestMergeProfile(t *testing.T) {
	existing := []ConnectionProfile{
		{Name: "COZZI P1", Host: "p1.local", User: "cozzi", SortOrder: 2, PinnedAt: 5, PasswordB64: "cHc="},
		{Name: "other", Host: "x.local", User: "x"},
	}

	t.Run("auto-save (name=host) preserves the custom name and ordering", func(t *testing.T) {
		auto := ConnectionProfile{Name: "p1.local", Host: "p1.local", User: "cozzi", SavePassword: true}
		out, replaced := mergeProfile([]ConnectionProfile{existing[0], existing[1]}, auto)
		if !replaced || len(out) != 2 {
			t.Fatalf("replaced=%v len=%d", replaced, len(out))
		}
		if out[0].Name != "COZZI P1" {
			t.Fatalf("name clobbered: %q", out[0].Name)
		}
		if out[0].SortOrder != 2 || out[0].PinnedAt != 5 {
			t.Fatalf("ordering lost: %+v", out[0])
		}
		if out[0].PasswordB64 != "cHc=" {
			t.Fatalf("password lost: %q", out[0].PasswordB64)
		}
	})

	t.Run("explicit rename updates the name", func(t *testing.T) {
		rename := ConnectionProfile{Name: "Renamed", Host: "p1.local", User: "cozzi"}
		out, _ := mergeProfile([]ConnectionProfile{existing[0]}, rename)
		if out[0].Name != "Renamed" {
			t.Fatalf("rename ignored: %q", out[0].Name)
		}
	})

	t.Run("no match appends", func(t *testing.T) {
		newP := ConnectionProfile{Name: "new", Host: "new.local", User: "n"}
		out, replaced := mergeProfile([]ConnectionProfile{existing[0]}, newP)
		if replaced || len(out) != 2 || out[1].Name != "new" {
			t.Fatalf("append wrong: replaced=%v out=%+v", replaced, out)
		}
	})
}
