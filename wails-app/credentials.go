// OS credential vault for saved-connection passwords.
//
// Passwords are stored in the OS secure store — macOS Keychain, Windows
// Credential Manager, Linux Secret Service (GNOME Keyring / KWallet via D-Bus)
// — keyed by "user@host". The profile file holds no secret material.
//
// When no secure store exists (headless Linux, containers, some CI), we fall
// back to the legacy base64-in-file behavior, which is obscurity only — the
// UI labels it "obscured, not encrypted" either way.
package main

import (
	"encoding/base64"
	"strings"

	"github.com/zalando/go-keyring"
)

const keyringService = "com.cozziresearch.ibmi-runsql"

// credentialsAvailable reports whether an OS secure store is usable on this
// machine (probed once; keyring errors at call time degrade to fallback).
var credentialsAvailable = probeKeyring()

func probeKeyring() bool {
	// A harmless probe: get of a never-set key returns ErrNotFound on a working
	// backend; anything else (dbus missing, etc.) means no secure store.
	_, err := keyring.Get(keyringService, "probe")
	return err == nil || err == keyring.ErrNotFound
}

// credKey normalizes the vault key: "user@host", both lower-cased.
func credKey(host, user string) string {
	return strings.ToLower(strings.TrimSpace(user)) + "@" + strings.ToLower(strings.TrimSpace(host))
}

// storePassword saves the password for user@host in the OS vault. No-op when
// password is empty or the vault is unavailable (caller falls back to base64).
func storePassword(host, user, password string) error {
	if !credentialsAvailable || password == "" {
		return errNoVault
	}
	return keyring.Set(keyringService, credKey(host, user), password)
}

// loadPassword returns the stored password for user@host ("" when none).
func loadPassword(host, user string) string {
	if !credentialsAvailable {
		return ""
	}
	pw, err := keyring.Get(keyringService, credKey(host, user))
	if err != nil {
		return ""
	}
	return pw
}

// deletePassword removes the stored password for user@host (best effort).
func deletePassword(host, user string) {
	if !credentialsAvailable {
		return
	}
	_ = keyring.Delete(keyringService, credKey(host, user))
}

// --- Legacy base64 migration -------------------------------------------------

// migrateLegacyPassword moves a profile's PasswordB64 into the OS vault and
// clears the in-file copy. Returns true when the profile changed (caller should
// re-save). No-op without a vault or when nothing is stored in-file.
func migrateLegacyPassword(p *ConnectionProfile) bool {
	if p.PasswordB64 == "" {
		return false
	}
	if credentialsAvailable {
		raw, err := base64.StdEncoding.DecodeString(p.PasswordB64)
		if err == nil && len(raw) > 0 {
			if storePassword(p.Host, p.User, string(raw)) == nil {
				p.PasswordB64 = ""
				return true
			}
		}
		return false // keep the in-file copy if the vault write failed
	}
	return false
}

type vaultError string

func (e vaultError) Error() string { return string(e) }

const errNoVault = vaultError("no OS credential vault available")
