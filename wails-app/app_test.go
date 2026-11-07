package main

import (
	"testing"
)

func names(profiles []ConnectionProfile) []string {
	out := make([]string, len(profiles))
	for i, p := range profiles {
		out[i] = p.Name
	}
	return out
}

func TestSortProfilesSmallListKeepsCreationOrder(t *testing.T) {
	// <=5 profiles: FILO — file (creation) order is preserved regardless of LastUsedAt.
	profiles := []ConnectionProfile{
		{Name: "zeta", LastUsedAt: 300},
		{Name: "alpha", LastUsedAt: 100},
		{Name: "mid", LastUsedAt: 200},
	}
	sortProfiles(profiles)
	got := names(profiles)
	want := []string{"zeta", "alpha", "mid"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("position %d: got %q, want %q (order %v)", i, got[i], want[i], got)
		}
	}
}

func TestSortProfilesSmallListPinnedFirst(t *testing.T) {
	profiles := []ConnectionProfile{
		{Name: "first", LastUsedAt: 300},
		{Name: "second", LastUsedAt: 100, PinnedAt: 10},
		{Name: "third", LastUsedAt: 200},
	}
	sortProfiles(profiles)
	got := names(profiles)
	if got[0] != "second" {
		t.Fatalf("pinned profile should lead, got %v", got)
	}
	if got[1] != "first" || got[2] != "third" {
		t.Fatalf("remainder should keep creation order, got %v", got)
	}
}

func TestSortProfilesLargeListMRUAfterPinned(t *testing.T) {
	profiles := make([]ConnectionProfile, 0, 7)
	for i, n := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		profiles = append(profiles, ConnectionProfile{Name: n, LastUsedAt: int64(i)})
	}
	profiles[2].PinnedAt = 5 // "c" pinned
	sortProfiles(profiles)
	got := names(profiles)
	if got[0] != "c" {
		t.Fatalf("pinned profile should lead, got %v", got)
	}
	// Rest MRU: LastUsedAt desc => g,f,e,d,b,a
	want := []string{"c", "g", "f", "e", "d", "b", "a"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("position %d: got %q, want %q (order %v)", i, got[i], want[i], got)
		}
	}
}

func TestSortProfilesMultiplePinnedMostRecentFirst(t *testing.T) {
	profiles := []ConnectionProfile{
		{Name: "a", PinnedAt: 10},
		{Name: "b", PinnedAt: 20},
		{Name: "c"},
	}
	sortProfiles(profiles)
	got := names(profiles)
	want := []string{"b", "a", "c"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("position %d: got %q, want %q (order %v)", i, got[i], want[i], got)
		}
	}
}
