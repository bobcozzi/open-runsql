package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

type fakeEnhancedBridge struct {
	calls  []string
	handle func(string, map[string]any) (map[string]any, error)
}

func (b *fakeEnhancedBridge) Call(op string, fields map[string]any) (map[string]any, error) {
	b.calls = append(b.calls, op)
	return b.handle(op, fields)
}
func (b *fakeEnhancedBridge) Alive() bool  { return true }
func (b *fakeEnhancedBridge) Close() error { return nil }

func enhancedInstallation(library, version, versionStatus string) map[string]any {
	return map[string]any{"library": library, "programExists": true, "routineExists": true, "routineMatches": true, "installed": true, "installedVersion": version, "versionStatus": versionStatus}
}

func verifiedDiscovery(library, version, bundled, versionStatus string) map[string]any {
	target := enhancedInstallation(library, version, versionStatus)
	target["bundledVersion"] = bundled
	result := enhancedInstallation(library, version, versionStatus)
	result["bundledVersion"] = bundled
	result["configuredTarget"] = target
	result["installations"] = []any{target}
	return map[string]any{"result": result}
}

func TestFunctionUpdateNotificationsSettings(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	app := NewApp("")
	if got := loadAppSettings().FunctionUpdateNotifications; got != "always" {
		t.Fatalf("default policy: %q", got)
	}
	for _, policy := range []string{"always", "newOnly", "updatesOnly", "noneAuto", "noneSkip"} {
		if err := app.SetAppSetting("functionUpdateNotifications", policy); err != nil || loadAppSettings().FunctionUpdateNotifications != policy {
			t.Fatalf("persist %s: %v", policy, err)
		}
	}
	before, err := os.ReadFile(settingsStorePath())
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"", "never", "ALWAYS", "updatesOnly ", "noneauto", "noneSkip "} {
		if err := app.SetAppSetting("functionUpdateNotifications", invalid); err == nil {
			t.Fatalf("accepted invalid policy %q", invalid)
		}
	}
	after, err := os.ReadFile(settingsStorePath())
	if err != nil || string(before) != string(after) {
		t.Fatalf("invalid policy modified settings: %v", err)
	}
	if err := os.WriteFile(settingsStorePath(), []byte(`{"functionUpdateNotifications":null}`), 0600); err != nil {
		t.Fatal(err)
	}
	if got := loadAppSettings().FunctionUpdateNotifications; got != "always" {
		t.Fatalf("null policy: %q", got)
	}
}

func TestFunctionUpdateNotificationsSettingsWriteFailure(t *testing.T) {
	t.Setenv("HOME", "/dev/null")
	if err := NewApp("").SetAppSetting("functionUpdateNotifications", "newOnly"); err == nil {
		t.Fatal("expected settings write failure")
	}
}

func TestEnhancedDiscoveryDoesNotActivateUnverifiedVersions(t *testing.T) {
	for _, test := range []struct {
		name, version, bundled, versionStatus string
		usable                                bool
	}{
		{"current", "1.9", "1.9", "current", true},
		{"newer", "1.10", "1.9", "newer", true},
		{"older", "1.8", "1.9", "older", false},
		{"unknown", "", "1.9", "unknown", false},
		{"misreported", "1.8", "1.9", "newer", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
				if op != "checkEnhancedSupport" {
					t.Fatalf("unexpected host operation %s", op)
				}
				return verifiedDiscovery("MYLIB", test.version, test.bundled, test.versionStatus), nil
			}}
			app := NewApp("")
			app.client = bridge
			state := &connState{id: "one", enhancedLibrary: "OLDLIB"}
			app.connections["one"] = state
			if _, err := app.CheckEnhancedSupport("one", "MYLIB"); err != nil {
				t.Fatal(err)
			}
			if (state.enhancedLibrary == "MYLIB") != test.usable || len(bridge.calls) != 1 {
				t.Fatalf("unexpected cached library %q, calls %v", state.enhancedLibrary, bridge.calls)
			}
		})
	}
}

func TestEnhancedDiscoveryPermissionFailureClearsCache(t *testing.T) {
	bridge := &fakeEnhancedBridge{handle: func(string, map[string]any) (map[string]any, error) {
		return nil, errors.New("not authorized to inspect catalog")
	}}
	app := NewApp("")
	app.client = bridge
	state := &connState{id: "one", enhancedLibrary: "OLDLIB"}
	app.connections["one"] = state
	if _, err := app.CheckEnhancedSupport("one", "MYLIB"); err == nil || state.enhancedLibrary != "" || len(bridge.calls) != 1 {
		t.Fatalf("permission failure retained cache or performed writes: %v, %q, %v", err, state.enhancedLibrary, bridge.calls)
	}
}

func TestEnhancedOperationFailureAfterDiscoveryDoesNotUseAlternative(t *testing.T) {
	for _, operation := range []string{"install", "repair", "upgrade"} {
		t.Run(operation, func(t *testing.T) {
			bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
				if op == "checkEnhancedSupport" {
					other := enhancedInstallation("OTHER", "2.0", "newer")
					other["bundledVersion"] = "1.9"
					configured := map[string]any{"library": "MYLIB", "programExists": operation == "repair", "routineExists": false, "installed": false}
					if operation == "upgrade" {
						configured = enhancedInstallation("MYLIB", "1.8", "older")
						configured["bundledVersion"] = "1.9"
						result := enhancedInstallation("MYLIB", "1.8", "older")
						result["bundledVersion"] = "1.9"
						result["configuredTarget"] = configured
						result["installations"] = []any{configured, other}
						return map[string]any{"result": result}, nil
					}
					result := enhancedInstallation("OTHER", "2.0", "newer")
					result["bundledVersion"] = "1.9"
					result["configuredTarget"] = configured
					result["installations"] = []any{other}
					return map[string]any{"result": result}, nil
				}
				if op != operation+"EnhancedSupport" || fields["connectionId"] != "one" || fields["library"] != "MYLIB" {
					t.Fatalf("unexpected operation: %s %v", op, fields)
				}
				wantFields := 2
				if operation != "install" {
					wantFields++
				}
				if len(fields) != wantFields {
					t.Fatalf("unexpected bridge request fields: %v", fields)
				}
				if operation == "repair" {
					encoded, _ := json.Marshal(fields["expectedState"])
					if string(encoded) != `{"programExists":true,"routineExists":false}` {
						t.Fatalf("unexpected repair guard: %s", encoded)
					}
				}
				if operation == "upgrade" && fields["expectedInstalledVersion"] != "1.8" {
					t.Fatalf("unexpected upgrade guard: %v", fields)
				}
				return nil, errors.New("host operation failed")
			}}
			app := NewApp("")
			app.client = bridge
			enabled := true
			app.connections["one"] = &connState{id: "one", enhancedLibrary: "OLDLIB", useEnhancedCLSupport: &enabled}
			app.connections["two"] = &connState{id: "two", enhancedLibrary: "SECOND"}
			if _, err := app.CheckEnhancedSupport("one", "MYLIB"); err != nil {
				t.Fatal(err)
			}
			var err error
			switch operation {
			case "install":
				_, err = app.InstallEnhancedSupport("one", "MYLIB")
			case "repair":
				_, err = app.RepairEnhancedSupport("one", "MYLIB")
			case "upgrade":
				_, err = app.UpgradeEnhancedSupport("one", "MYLIB", "1.8")
			}
			if err == nil || app.connections["one"].enhancedLibrary != "" || app.connections["two"].enhancedLibrary != "SECOND" {
				t.Fatalf("failure enabled fallback or changed another connection: %v", err)
			}
			if _, err := app.Run(RunRequest{ConnectionID: "one", Text: "CL: DSPJOB"}); err == nil || len(bridge.calls) != 2 {
				t.Fatalf("failure retried or allowed fallback: %v %v", err, bridge.calls)
			}
		})
	}
}

func TestSelectEnhancedSupport(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
		if op != "checkEnhancedSupport" || fields["connectionId"] != "one" || fields["library"] != "OTHER" {
			t.Fatalf("unexpected selection request: %s %v", op, fields)
		}
		return verifiedDiscovery("OTHER", "1.10", "1.9", "newer"), nil
	}}
	app := NewApp("")
	app.client = bridge
	app.connections["one"] = &connState{id: "one", enhancedLibrary: "OLDLIB"}
	app.connections["two"] = &connState{id: "two", enhancedLibrary: "SECOND"}
	status, err := app.SelectEnhancedSupport("one", "other")
	if err != nil || status.Library != "OTHER" || app.connections["one"].enhancedLibrary != "OTHER" ||
		app.connections["two"].enhancedLibrary != "SECOND" || loadAppSettings().EnhancedSupportLibrary != "OTHER" || len(bridge.calls) != 1 {
		t.Fatalf("selection: %+v %v", status, err)
	}
}

func TestSelectEnhancedSupportRejectsChanges(t *testing.T) {
	for _, test := range []struct{ name, version, bundled, state string }{
		{"older", "1.9", "1.10", "newer"},
		{"unknown", "", "1.0", "unknown"},
		{"invalid version", "1.x", "1.0", "current"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			bridge := &fakeEnhancedBridge{handle: func(string, map[string]any) (map[string]any, error) {
				return verifiedDiscovery("OTHER", test.version, test.bundled, test.state), nil
			}}
			app := NewApp("")
			app.client = bridge
			app.connections["one"] = &connState{id: "one", enhancedLibrary: "OLDLIB"}
			if _, err := app.SelectEnhancedSupport("one", "OTHER"); err == nil || app.connections["one"].enhancedLibrary != "OLDLIB" || loadAppSettings().EnhancedSupportLibrary != "SQLTOOLS" {
				t.Fatalf("invalid selection changed state: %v", err)
			}
		})
	}
}

func TestSelectEnhancedSupportDisconnectAndIllegalTargets(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	app := NewApp("")
	state := &connState{id: "one", enhancedLibrary: "OLDLIB"}
	app.connections["one"] = state
	bridge := &fakeEnhancedBridge{handle: func(string, map[string]any) (map[string]any, error) {
		app.mu.Lock()
		delete(app.connections, "one")
		app.mu.Unlock()
		return verifiedDiscovery("OTHER", "1", "1.0", "current"), nil
	}}
	app.client = bridge
	for _, library := range []string{"QFOO", "A;DROP", "QTEMP"} {
		if _, err := app.SelectEnhancedSupport("one", library); err == nil || len(bridge.calls) != 0 {
			t.Fatalf("illegal target %s accepted: %v", library, err)
		}
	}
	if _, err := app.SelectEnhancedSupport("one", "OTHER"); err == nil || state.enhancedLibrary != "OLDLIB" || loadAppSettings().EnhancedSupportLibrary != "SQLTOOLS" {
		t.Fatalf("disconnect changed state: %v", err)
	}
}

func TestSelectEnhancedSupportSettingsFailure(t *testing.T) {
	t.Setenv("HOME", "/dev/null")
	app := NewApp("")
	app.client = &fakeEnhancedBridge{handle: func(string, map[string]any) (map[string]any, error) {
		return verifiedDiscovery("OTHER", "1", "1.0", "current"), nil
	}}
	state := &connState{id: "one", enhancedLibrary: "OLDLIB"}
	app.connections["one"] = state
	if _, err := app.SelectEnhancedSupport("one", "OTHER"); err == nil || state.enhancedLibrary != "OLDLIB" {
		t.Fatalf("failed settings write changed session: %v", err)
	}
}

func TestEnhancedOverrideJSON(t *testing.T) {
	for _, value := range []string{`{}`, `{"useEnhancedCLSupport":false}`, `{"useEnhancedCLSupport":true}`} {
		var request ConnectRequest
		if err := json.Unmarshal([]byte(value), &request); err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(struct {
			Value *bool `json:"useEnhancedCLSupport,omitempty"`
		}{request.UseEnhancedCLSupport})
		if err != nil || string(encoded) != value {
			t.Fatalf("%s: %s %v", value, encoded, err)
		}
	}
}

func TestEnhancedSupportPerConnection(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	bridge := &fakeEnhancedBridge{}
	bridge.handle = func(op string, fields map[string]any) (map[string]any, error) {
		switch op {
		case "connect":
			return map[string]any{"connectionId": fields["host"]}, nil
		case "checkEnhancedSupport":
			return map[string]any{"result": map[string]any{"library": "BESTLIB", "installed": true, "installedVersion": "3.0.0", "bundledVersion": "2.0.0", "versionStatus": "newer", "configuredTarget": map[string]any{"library": "MYLIB", "programExists": true, "routineExists": false, "installed": false}, "installations": []any{enhancedInstallation("BESTLIB", "3.0.0", "newer")}}}, nil
		case "executeEnhancedCL":
			if fields["library"] != "BESTLIB" {
				t.Fatalf("execution used %v", fields["library"])
			}
			return map[string]any{"result": map[string]any{"ok": true}}, nil
		case "executeCL":
			return map[string]any{"result": map[string]any{"ok": true}}, nil
		default:
			t.Fatalf("unexpected operation %s", op)
			return nil, nil
		}
	}
	app := NewApp("")
	app.client = bridge
	enabled, disabled := true, false
	for _, req := range []ConnectRequest{{Host: "enabled", User: "u", UseEnhancedCLSupport: &enabled}, {Host: "disabled", User: "u", UseEnhancedCLSupport: &disabled}, {Host: "legacy", User: "u"}} {
		if _, err := app.Connect(req); err != nil {
			t.Fatal(err)
		}
	}
	enabled, disabled = false, true
	if err := app.SetAppSetting("clExecutionMode", "sqlJob"); err != nil {
		t.Fatal(err)
	}
	if err := app.SetAppSetting("enhancedSupportLibrary", "MYLIB"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"disabled", "legacy"} {
		start := len(bridge.calls)
		if _, err := app.Run(RunRequest{ConnectionID: id, Text: "CL: DSPJOB"}); err != nil || strings.Join(bridge.calls[start:], ",") != "executeCL" {
			t.Fatalf("%s: %v %v", id, err, bridge.calls[start:])
		}
	}
	start := len(bridge.calls)
	if _, err := app.Run(RunRequest{ConnectionID: "enabled", Text: "CL: DSPJOB"}); err == nil || len(bridge.calls) != start {
		t.Fatal("enabled connection must not execute before discovery")
	}
	status, err := app.CheckEnhancedSupport("enabled", "MYLIB")
	if err != nil || status.Library != "BESTLIB" || status.InstalledVersion != "3.0.0" || status.ConfiguredTarget == nil || !status.ConfiguredTarget.ProgramExists {
		t.Fatalf("status: %+v %v", status, err)
	}
	if err := app.SetAppSetting("enhancedSupportLibrary", "OTHER"); err != nil {
		t.Fatal(err)
	}
	start = len(bridge.calls)
	if _, err := app.Run(RunRequest{ConnectionID: "enabled", Text: "CL: DSPJOB"}); err == nil || len(bridge.calls) != start {
		t.Fatal("an unrelated discovered library must not be enabled without selection")
	}
}

func TestCLExecutionModesSelectExpectedBridgeOperation(t *testing.T) {
	bridge := &fakeEnhancedBridge{}
	bridge.handle = func(op string, fields map[string]any) (map[string]any, error) {
		switch op {
		case "connect":
			return map[string]any{"connectionId": fields["host"]}, nil
		case "executeCL", "executeQcmdexcFunction", "executeEnhancedCL":
			return map[string]any{"result": map[string]any{"ok": true, "messages": []any{}}}, nil
		default:
			return nil, fmt.Errorf("unexpected bridge operation %s", op)
		}
	}
	app := NewApp("")
	app.client = bridge
	for _, mode := range []string{"standard", "qcmdexc", "enhanced"} {
		response, err := app.Connect(ConnectRequest{Host: mode, User: "u", CLExecutionMode: mode})
		if err != nil {
			t.Fatalf("connect mode %s: %v", mode, err)
		}
		if mode == "enhanced" {
			app.connections[response.ConnectionID].enhancedLibrary = "MYLIB"
		}
		bridge.calls = nil
		if _, err := app.Run(RunRequest{ConnectionID: response.ConnectionID, Text: "CL: DSPLIBL"}); err != nil {
			t.Fatalf("run mode %s: %v", mode, err)
		}
		want := map[string]string{"standard": "executeCL", "qcmdexc": "executeQcmdexcFunction", "enhanced": "executeEnhancedCL"}[mode]
		if len(bridge.calls) != 1 || bridge.calls[0] != want {
			t.Fatalf("mode %s called %v, want %s", mode, bridge.calls, want)
		}
	}
	if _, err := app.Connect(ConnectRequest{Host: "invalid", User: "u", CLExecutionMode: "procedure"}); err == nil {
		t.Fatal("invalid CL mode was accepted")
	}
}

func TestEnhancedModeFallsBackToQcmdexcWithoutCppCompiler(t *testing.T) {
	bridge := &fakeEnhancedBridge{}
	bridge.handle = func(op string, fields map[string]any) (map[string]any, error) {
		switch op {
		case "connect":
			return map[string]any{"connectionId": fields["host"]}, nil
		case "checkEnhancedSupport":
			target := map[string]any{"library": "SQLTOOLS", "programExists": false, "routineExists": false,
				"routineMatches": false, "installed": false, "bundledVersion": "0.2.1", "versionStatus": "unknown"}
			return map[string]any{"result": map[string]any{"library": "SQLTOOLS", "programExists": false, "routineExists": false,
				"routineMatches": false, "installed": false, "bundledVersion": "0.2.1", "versionStatus": "unknown",
				"configuredTarget": target, "installations": []any{}, "cppCompilerAvailable": false}}, nil
		case "executeQcmdexcFunction":
			return map[string]any{"result": map[string]any{"ok": true, "messages": []any{}}}, nil
		default:
			return nil, fmt.Errorf("unexpected bridge operation %s", op)
		}
	}
	app := NewApp("")
	app.client = bridge
	connected, err := app.Connect(ConnectRequest{Host: "compiler-missing", User: "u", CLExecutionMode: "enhanced"})
	if err != nil {
		t.Fatal(err)
	}
	status, err := app.CheckEnhancedSupport(connected.ConnectionID, "SQLTOOLS")
	if err != nil || status.CppCompilerAvailable == nil || *status.CppCompilerAvailable {
		t.Fatalf("compiler status: %+v, %v", status, err)
	}
	if state := app.connections[connected.ConnectionID]; state.clExecutionMode != "qcmdexc" || state.enhancedLibrary != "" {
		t.Fatalf("connection did not fall back to QCMDEXC: %+v", state)
	}
	bridge.calls = nil
	if _, err := app.Run(RunRequest{ConnectionID: connected.ConnectionID, Text: "CL: DSPLIBL"}); err != nil {
		t.Fatal(err)
	}
	if len(bridge.calls) != 1 || bridge.calls[0] != "executeQcmdexcFunction" {
		t.Fatalf("fallback called %v, want executeQcmdexcFunction", bridge.calls)
	}
}

func TestEmptyEnhancedResultPreservesWorkspace(t *testing.T) {
	withTempStore(t)
	bridge := &fakeEnhancedBridge{handle: func(op string, _ map[string]any) (map[string]any, error) {
		if op != "executeEnhancedCL" {
			return nil, fmt.Errorf("unexpected bridge operation %s", op)
		}
		return map[string]any{"result": map[string]any{
			"ok": true, "messages": []any{}, "resultSet": map[string]any{
				"kind": "rows", "columns": []any{}, "rows": []any{}, "elapsedMs": int64(1),
			},
		}}, nil
	}}
	app := NewApp("")
	app.client = bridge
	app.connections["conn"] = &connState{id: "conn", clExecutionMode: "enhanced", enhancedLibrary: "MYLIB"}
	app.workspace.Update("conn", func(workspace *WorkspaceState) {
		workspace.Columns = []ColumnInfo{{Name: "ID", Label: "ID"}}
		workspace.Rows = [][]any{{42}}
		workspace.ShowingResults = true
		workspace.ResultStatement = "VALUES 42"
	})
	result, err := app.runCL(bridge, "conn", "OVRDBF FILE(INPUT)")
	if err != nil {
		t.Fatal(err)
	}
	if !result.PreserveResults || result.ResultSet != nil {
		t.Fatalf("result preserve=%v resultSet=%+v", result.PreserveResults, result.ResultSet)
	}
	workspace := app.GetWorkspace("conn")
	if len(workspace.Rows) != 1 || workspace.Rows[0][0] != 42 || workspace.ResultStatement != "VALUES 42" {
		t.Fatalf("workspace result changed: %+v", workspace)
	}
}

func TestEnhancedDiscoveryErrorsAndInstallTarget(t *testing.T) {
	bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
		if op == "checkEnhancedSupport" {
			return nil, errors.New("catalog unavailable")
		}
		return map[string]any{"result": map[string]any{"library": "OTHER", "installed": true}}, nil
	}}
	app := NewApp("")
	app.client = bridge
	app.connections["one"] = &connState{id: "one"}
	if _, err := app.CheckEnhancedSupport("one", "MYLIB"); err == nil {
		t.Fatal("catalog error lost")
	}
	if _, err := app.InstallEnhancedSupport("one", "MYLIB"); err == nil || app.connections["one"].enhancedLibrary != "" {
		t.Fatal("install response must match target")
	}
}

func TestEnhancedDiscoveryRejectsLegacyResponse(t *testing.T) {
	bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
		return map[string]any{"result": map[string]any{"library": "MYLIB", "installed": false}}, nil
	}}
	app := NewApp("")
	app.client = bridge
	app.connections["one"] = &connState{id: "one"}
	if _, err := app.CheckEnhancedSupport("one", "MYLIB"); err == nil || !strings.Contains(err.Error(), "updated JDBC bridge") || app.connections["one"].enhancedLibrary != "" {
		t.Fatalf("legacy discovery must fail closed: %v", err)
	}
}

func TestEnhancedDiscoveryValidatesInstallations(t *testing.T) {
	valid := enhancedInstallation("OTHER", "1.0", "current")
	for name, entries := range map[string]any{
		"missing":          nil,
		"wrong type":       "bad",
		"invalid name":     []any{enhancedInstallation("BAD.NAME", "1.0", "current")},
		"duplicate":        []any{valid, enhancedInstallation("other", "1.0", "current")},
		"missing selected": []any{enhancedInstallation("ANOTHER", "1.0", "current")},
		"incomplete":       []any{map[string]any{"library": "OTHER", "installed": true}},
	} {
		t.Run(name, func(t *testing.T) {
			bridge := &fakeEnhancedBridge{handle: func(string, map[string]any) (map[string]any, error) {
				return map[string]any{"result": map[string]any{"library": "OTHER", "installed": true, "configuredTarget": map[string]any{"library": "MYLIB"}, "installations": entries}}, nil
			}}
			app := NewApp("")
			app.client = bridge
			app.connections["one"] = &connState{id: "one", enhancedLibrary: "OLDLIB"}
			if _, err := app.CheckEnhancedSupport("one", "MYLIB"); err == nil || app.connections["one"].enhancedLibrary != "" {
				t.Fatalf("invalid discovery enabled execution: %v", err)
			}
		})
	}
}

func TestEnhancedDiscoverySerializesEmptyInstallations(t *testing.T) {
	bridge := &fakeEnhancedBridge{handle: func(string, map[string]any) (map[string]any, error) {
		return map[string]any{"result": map[string]any{"library": "MYLIB", "configuredTarget": map[string]any{"library": "MYLIB"}, "installations": []any{}}}, nil
	}}
	app := NewApp("")
	app.client = bridge
	app.connections["one"] = &connState{id: "one"}
	status, err := app.CheckEnhancedSupport("one", "MYLIB")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(status)
	if err != nil || !strings.Contains(string(encoded), `"installations":[]`) {
		t.Fatalf("empty installations: %s %v", encoded, err)
	}
}

func TestEnhancedDiscoveryDecodesJSONInstallations(t *testing.T) {
	var response map[string]any
	input := `{"result":{"library":"OTHER","installed":true,"installedVersion":null,"versionStatus":"unknown","configuredTarget":{"library":"MYLIB","installed":false},"installations":[{"library":"OTHER","programExists":true,"routineExists":true,"routineMatches":true,"installed":true,"installedVersion":null,"bundledVersion":"0.2.0","versionStatus":"unknown"},{"library":"SECOND","programExists":true,"routineExists":true,"routineMatches":true,"installed":true,"installedVersion":"0.1.0","versionStatus":"older"}]}}`
	if err := json.Unmarshal([]byte(input), &response); err != nil {
		t.Fatal(err)
	}
	bridge := &fakeEnhancedBridge{handle: func(string, map[string]any) (map[string]any, error) { return response, nil }}
	app := NewApp("")
	app.client = bridge
	app.connections["one"] = &connState{id: "one"}
	status, err := app.CheckEnhancedSupport("one", "MYLIB")
	if err != nil || len(status.Installations) != 2 || status.Installations[0].InstalledVersion != "" || status.Installations[1].InstalledVersion != "0.1.0" || app.connections["one"].enhancedLibrary != "" {
		t.Fatalf("JSON discovery: %+v %v", status, err)
	}
	response["result"].(map[string]any)["versionStatus"] = "current"
	if _, err := app.CheckEnhancedSupport("one", "MYLIB"); err == nil || app.connections["one"].enhancedLibrary != "" {
		t.Fatalf("inconsistent selected metadata enabled execution: %v", err)
	}
}

func TestEnhancedDiscoveryDecodesNewerCandidateAndUsesConfiguredLibrary(t *testing.T) {
	bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
		if op == "executeEnhancedCL" {
			if fields["library"] != "MYLIB" {
				t.Fatalf("execution used %v", fields["library"])
			}
			return map[string]any{"result": map[string]any{"ok": true}}, nil
		}
		target := enhancedInstallation("MYLIB", "1.9", "current")
		target["bundledVersion"] = "1.9"
		return map[string]any{"result": map[string]any{
			"library": "MYLIB", "installed": true, "programExists": true, "routineExists": true, "routineMatches": true, "installedVersion": "1.9", "bundledVersion": "1.9", "versionStatus": "current",
			"configuredTarget": target,
			"newerAvailable":   map[string]any{"library": "OTHER", "installed": true, "installedVersion": "1.10", "versionStatus": "newer"},
			"installations":    []any{enhancedInstallation("OTHER", "1.10", "newer"), enhancedInstallation("MYLIB", "1.9", "current"), enhancedInstallation("UNKNOWN", "", "unknown")},
		}}, nil
	}}
	app := NewApp("")
	app.client = bridge
	enabled := true
	app.connections["one"] = &connState{id: "one", useEnhancedCLSupport: &enabled}
	status, err := app.CheckEnhancedSupport("one", "MYLIB")
	if err != nil || status.NewerAvailable == nil || status.NewerAvailable.Library != "OTHER" || status.NewerAvailable.InstalledVersion != "1.10" || len(status.Installations) != 3 || status.Installations[2].InstalledVersion != "" {
		t.Fatalf("newer candidate: %+v %v", status, err)
	}
	encoded, err := json.Marshal(status)
	if err != nil || !strings.Contains(string(encoded), `"newerAvailable":{"library":"OTHER"`) {
		t.Fatalf("serialized status: %s %v", encoded, err)
	}
	if _, err := app.runCL(bridge, "one", "DSPJOB"); err != nil {
		t.Fatal(err)
	}
}

func TestEnhancedDiscoveryRejectsMalformedNewerCandidate(t *testing.T) {
	for _, candidate := range []any{"bad", map[string]any{"library": "BAD.NAME", "installed": true, "installedVersion": "2"}, map[string]any{"library": "OTHER", "installed": true, "installedVersion": "2.x"}} {
		bridge := &fakeEnhancedBridge{handle: func(string, map[string]any) (map[string]any, error) {
			return map[string]any{"result": map[string]any{"library": "MYLIB", "installed": true, "configuredTarget": map[string]any{"library": "MYLIB", "installed": true}, "installations": []any{enhancedInstallation("MYLIB", "1", "current")}, "newerAvailable": candidate}}, nil
		}}
		app := NewApp("")
		app.client = bridge
		app.connections["one"] = &connState{id: "one"}
		if _, err := app.CheckEnhancedSupport("one", "MYLIB"); err == nil {
			t.Fatalf("accepted malformed candidate: %v", candidate)
		}
	}
}

func TestEnhancedUpgradeUsesDiscoveredLibraryAndExactVersion(t *testing.T) {
	bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
		if op == "checkEnhancedSupport" {
			return map[string]any{"result": map[string]any{"library": "BESTLIB", "installed": true, "installedVersion": "0.01.0", "versionStatus": "older", "configuredTarget": map[string]any{"library": "MYLIB"}, "installations": []any{enhancedInstallation("BESTLIB", "0.01.0", "older")}}}, nil
		}
		if op != "upgradeEnhancedSupport" || fields["connectionId"] != "one" || fields["library"] != "BESTLIB" || fields["expectedInstalledVersion"] != "0.01.0" {
			t.Fatalf("unexpected upgrade request: %s %v", op, fields)
		}
		return map[string]any{"result": map[string]any{"library": "BESTLIB", "installed": true, "versionStatus": "current", "version": "0.2.0", "installedVersion": "0.2.0", "bundledVersion": "0.2.0", "previousVersion": "0.01.0", "cppMember": "CPP", "sqlMember": "SQL", "module": "MOD"}}, nil
	}}
	app := NewApp("")
	app.client = bridge
	app.connections["one"] = &connState{id: "one"}
	status, err := app.CheckEnhancedSupport("one", "MYLIB")
	if err != nil || app.connections["one"].enhancedLibrary != "" {
		t.Fatalf("older discovery must not enable execution: %+v %v", status, err)
	}
	status, err = app.UpgradeEnhancedSupport("one", status.Library, status.InstalledVersion)
	if err != nil || app.connections["one"].enhancedLibrary != "BESTLIB" || status.PreviousVersion != "0.01.0" || status.CPPMember != "CPP" || status.SQLMember != "SQL" || status.Module != "MOD" {
		t.Fatalf("upgrade: %+v %v", status, err)
	}
}

func TestEnhancedRepairProtocolAndFallback(t *testing.T) {
	state := &connState{id: "one", enhancedLibrary: "BESTLIB"}
	bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
		if state.opMu.TryLock() {
			state.opMu.Unlock()
			t.Fatal("repair did not hold session lock")
		}
		encoded, err := json.Marshal(fields)
		if err != nil || op != "repairEnhancedSupport" || string(encoded) != `{"connectionId":"one","expectedState":{"programExists":true,"routineExists":false},"library":"QGPL"}` {
			t.Fatalf("repair request: %s %s %v", op, encoded, err)
		}
		return map[string]any{"result": map[string]any{"library": "QGPL", "programExists": true, "routineExists": true, "routineMatches": true, "installed": true, "versionStatus": "current", "version": "0.2.0", "installedVersion": "0.2.0", "bundledVersion": "0.2.0", "cppMember": "CPP", "sqlMember": "SQL", "module": "MOD"}}, nil
	}}
	app := NewApp("")
	app.client = bridge
	app.connections["one"] = state
	status, err := app.RepairEnhancedSupport("one", "qgpl")
	if err != nil || state.enhancedLibrary != "QGPL" || status.Library != "QGPL" || len(bridge.calls) != 1 {
		t.Fatalf("repair: %+v %v %v", status, err, bridge.calls)
	}
}

func TestEnhancedRepairFailurePreservesOnlySeparateFallback(t *testing.T) {
	for _, cached := range []string{"BESTLIB", "MYLIB", ""} {
		t.Run(cached, func(t *testing.T) {
			enabled := true
			state := &connState{id: "one", enhancedLibrary: cached, useEnhancedCLSupport: &enabled}
			bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
				if op == "executeEnhancedCL" && fields["library"] == "BESTLIB" {
					return map[string]any{"result": map[string]any{"ok": true}}, nil
				}
				return nil, errors.New("registration failed")
			}}
			app := NewApp("")
			app.client = bridge
			app.connections["one"] = state
			if _, err := app.RepairEnhancedSupport("one", "MYLIB"); err == nil || len(bridge.calls) != 1 {
				t.Fatalf("repair failure: %v %v", err, bridge.calls)
			}
			want := ""
			if cached == "BESTLIB" {
				want = cached
			}
			if state.enhancedLibrary != want {
				t.Fatalf("cached %q, want %q", state.enhancedLibrary, want)
			}
			_, err := app.Run(RunRequest{ConnectionID: "one", Text: "CL: DSPJOB"})
			if want == "" && (err == nil || len(bridge.calls) != 1) || want != "" && (err != nil || strings.Join(bridge.calls, ",") != "repairEnhancedSupport,executeEnhancedCL") {
				t.Fatalf("execution after repair: %v %v", err, bridge.calls)
			}
		})
	}
}

func TestEnhancedRepairRejectsTargetsAndResponses(t *testing.T) {
	result := func() map[string]any {
		return map[string]any{"library": "MYLIB", "programExists": true, "routineExists": true, "routineMatches": true, "installed": true, "versionStatus": "current", "version": "0.2.0", "installedVersion": "0.2.0", "bundledVersion": "0.2.0", "cppMember": "CPP", "sqlMember": "SQL", "module": "MOD"}
	}
	for field, value := range map[string]any{"library": "OTHER", "programExists": false, "routineExists": false, "routineMatches": false, "installed": false, "versionStatus": "older", "version": "bad", "installedVersion": "0.1", "bundledVersion": "0.1", "cppMember": "", "sqlMember": "", "module": ""} {
		t.Run(field, func(t *testing.T) {
			response := result()
			response[field] = value
			bridge := &fakeEnhancedBridge{handle: func(string, map[string]any) (map[string]any, error) { return map[string]any{"result": response}, nil }}
			app := NewApp("")
			app.client = bridge
			app.connections["one"] = &connState{id: "one", enhancedLibrary: "BESTLIB"}
			if _, err := app.RepairEnhancedSupport("one", "MYLIB"); err == nil || app.connections["one"].enhancedLibrary != "BESTLIB" || len(bridge.calls) != 1 {
				t.Fatalf("invalid %s accepted: %v %v", field, err, bridge.calls)
			}
		})
	}
	bridge := &fakeEnhancedBridge{handle: func(string, map[string]any) (map[string]any, error) {
		t.Fatal("invalid target reached bridge")
		return nil, nil
	}}
	app := NewApp("")
	app.client = bridge
	app.connections["one"] = &connState{id: "one", enhancedLibrary: "BESTLIB"}
	for _, library := range []string{"", "QSYS", "QTEMP", "QFOO", "LIB.NAME", "LIB/NAME"} {
		if _, err := app.RepairEnhancedSupport("one", library); err == nil || app.connections["one"].enhancedLibrary != "BESTLIB" {
			t.Fatalf("invalid target %q: %v", library, err)
		}
	}
}

func TestEnhancedUpgradeFailureDoesNotRetryOrEnable(t *testing.T) {
	bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
		return nil, errors.New("replacement failed")
	}}
	app := NewApp("")
	app.client = bridge
	enabled := true
	app.connections["one"] = &connState{id: "one", enhancedLibrary: "BESTLIB", useEnhancedCLSupport: &enabled}
	for _, version := range []string{"", " 1.0", "1.x", "1.0 "} {
		if _, err := app.UpgradeEnhancedSupport("one", "BESTLIB", version); err == nil {
			t.Fatalf("accepted version %q", version)
		}
	}
	if _, err := app.UpgradeEnhancedSupport("one", "BESTLIB", "1.0"); err == nil || app.connections["one"].enhancedLibrary != "" || strings.Join(bridge.calls, ",") != "upgradeEnhancedSupport" {
		t.Fatalf("failure retried or enabled: %v %v", bridge.calls, err)
	}
	if _, err := app.Run(RunRequest{ConnectionID: "one", Text: "CL: DSPJOB"}); err == nil || len(bridge.calls) != 1 {
		t.Fatalf("failed upgrade allowed execution: %v %v", bridge.calls, err)
	}
}

func TestEnhancedUpgradeRejectsInvalidResponseAndHoldsSessionLock(t *testing.T) {
	for _, returnedLibrary := range []string{"OTHER", "BESTLIB"} {
		t.Run(returnedLibrary, func(t *testing.T) {
			state := &connState{id: "one", enhancedLibrary: "BESTLIB"}
			bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
				if state.opMu.TryLock() {
					state.opMu.Unlock()
					t.Fatal("upgrade did not hold session lock")
				}
				return map[string]any{"result": map[string]any{"library": returnedLibrary, "installed": true, "versionStatus": "current"}}, nil
			}}
			app := NewApp("")
			app.client = bridge
			app.connections["one"] = state
			if _, err := app.UpgradeEnhancedSupport("one", "BESTLIB", "0.1.0"); err == nil || state.enhancedLibrary != "" || len(bridge.calls) != 1 {
				t.Fatalf("invalid response enabled execution: %v %v", bridge.calls, err)
			}
		})
	}
}

func TestEnhancedDiscoveryIsolatedBetweenSessions(t *testing.T) {
	bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
		connection := fields["connectionId"].(string)
		library := map[string]string{"one": "FIRSTLIB", "two": "SECONDLIB"}[connection]
		switch op {
		case "checkEnhancedSupport":
			target := enhancedInstallation(library, "1.0", "current")
			target["bundledVersion"] = "1.0"
			result := enhancedInstallation(library, "1.0", "current")
			result["bundledVersion"] = "1.0"
			result["configuredTarget"] = target
			result["installations"] = []any{target}
			return map[string]any{"result": result}, nil
		case "executeEnhancedCL":
			if fields["library"] != library {
				t.Fatalf("%s used %v instead of %s", connection, fields["library"], library)
			}
			return map[string]any{"result": map[string]any{"ok": true}}, nil
		default:
			t.Fatalf("unexpected operation %s", op)
			return nil, nil
		}
	}}
	app := NewApp("")
	app.client = bridge
	enabled := true
	for _, connection := range []string{"one", "two"} {
		app.connections[connection] = &connState{id: connection, useEnhancedCLSupport: &enabled}
		library := map[string]string{"one": "FIRSTLIB", "two": "SECONDLIB"}[connection]
		if _, err := app.CheckEnhancedSupport(connection, library); err != nil {
			t.Fatal(err)
		}
	}
	for _, connection := range []string{"one", "two"} {
		if _, err := app.Run(RunRequest{ConnectionID: connection, Text: "CL: DSPJOB"}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestEnhancedSupportSettings(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	app := &App{}
	settings, err := app.GetAppSettings()
	if err != nil || settings.EnhancedSupportLibrary != "SQLTOOLS" {
		t.Fatalf("defaults: %+v %v", settings, err)
	}
	for input, want := range map[string]string{"": "SQLTOOLS", "sqltools": "SQLTOOLS", "qGpL": "QGPL", "mylib": "MYLIB", "#a$b": "#A$B", "A123456789": "A123456789"} {
		if err := app.SetAppSetting("enhancedSupportLibrary", input); err != nil || loadAppSettings().EnhancedSupportLibrary != want {
			t.Fatalf("library %q: %v", input, err)
		}
	}
	for _, input := range []string{"QTEMP", "qtemp", "QSYS", "qsys", "QFOO", "qFoo", "1LIB", "TOOLONGNAME", "LIB.NAME", "LIB/NAME", "A;DROP", "É"} {
		if app.SetAppSetting("enhancedSupportLibrary", input) == nil {
			t.Errorf("accepted %q", input)
		}
	}
}

func TestEnhancedSupportWriteTargetsAndDiscovery(t *testing.T) {
	bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
		if op == "executeEnhancedCL" {
			if fields["library"] != "QFOO" {
				t.Fatalf("execution used %v", fields["library"])
			}
			return map[string]any{"result": map[string]any{"ok": true}}, nil
		}
		if op == "installEnhancedSupport" {
			return map[string]any{"result": map[string]any{"library": fields["library"], "installed": true, "versionStatus": "current"}}, nil
		}
		return map[string]any{"result": map[string]any{"library": "QFOO", "installed": true, "versionStatus": "current", "configuredTarget": map[string]any{"library": fields["library"]}, "installations": []any{enhancedInstallation("QFOO", "", "current")}}}, nil
	}}
	app := NewApp("")
	app.client = bridge
	enabled := true
	app.connections["one"] = &connState{id: "one", useEnhancedCLSupport: &enabled}
	for _, library := range []string{"QSYS", "qsys", "QTEMP", "qtemp", "QFOO", "qFoo"} {
		if _, err := app.InstallEnhancedSupport("one", library); err == nil || !strings.Contains(err.Error(), "except QGPL") {
			t.Errorf("install %s: %v", library, err)
		}
		if _, err := app.UpgradeEnhancedSupport("one", library, "0.1.0"); err == nil || !strings.Contains(err.Error(), "except QGPL") {
			t.Errorf("upgrade %s: %v", library, err)
		}
	}
	if len(bridge.calls) != 0 {
		t.Fatalf("forbidden write requests reached bridge: %v", bridge.calls)
	}
	status, err := app.CheckEnhancedSupport("one", "SQLTOOLS")
	if err != nil || status.Library != "QFOO" || app.connections["one"].enhancedLibrary != "" {
		t.Fatalf("discovered Q library: %+v %v", status, err)
	}
	if _, err := app.runCL(bridge, "one", "DSPJOB"); err == nil {
		t.Fatal("forbidden discovered library must not be enabled")
	}
	for _, library := range []string{"qgpl", "SQLTOOLS"} {
		if _, err := app.InstallEnhancedSupport("one", library); err != nil {
			t.Errorf("valid install target %s: %v", library, err)
		}
	}
}

func TestDecodeCLEmptyMessages(t *testing.T) {
	result := decodeCLResult("CMD", map[string]any{"ok": true, "messages": []any{}})
	if !result.OK || result.Messages == nil || len(result.Messages) != 0 {
		t.Fatalf("unexpected empty result: %+v", result)
	}
}

func TestEnhancedMessagesAndResultWorkspace(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	enabled := true
	bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
		return map[string]any{"result": map[string]any{
			"ok": true, "messages": []any{map[string]any{"id": "CPC0001", "severity": 0, "typeName": "*COMP", "text": "Done", "secondLevelText": "Help", "sentTimestamp": "2026-11-13 12:34:56.123456", "sentByUser": "USER", "fromProgram": "PGM", "fromModule": "MOD", "fromProcedure": "PROC", "fromStatement": "1234", "toProgram": "PGM2", "toModule": "MOD2", "toProcedure": "PROC2", "toStatement": "5678"}},
			"resultSet": map[string]any{"kind": "rows", "columns": []any{map[string]any{"name": "SENT_TIMESTAMP", "type": 93, "typeName": "TIMESTAMP", "scale": 6}}, "rows": []any{[]any{"2026-11-13 12:34:56.123456"}, []any{nil}}},
		}}, nil
	}}
	app := NewApp("")
	app.client = bridge
	app.connections["one"] = &connState{id: "one", useEnhancedCLSupport: &enabled, enhancedLibrary: "LIB"}
	if loadAppSettings().ShowCLMessagesInResults {
		t.Fatal("default must be off")
	}
	first, err := app.Run(RunRequest{ConnectionID: "one", Text: "CL: DSPJOB"})
	if err != nil {
		t.Fatal(err)
	}
	message := first.(*CLResult).Messages[0]
	if first.(*CLResult).ResultSet != nil || message.FromProgram != "PGM" || message.FromModule != "MOD" || message.FromProcedure != "PROC" || message.FromStatement != "1234" || message.ToProgram != "PGM2" || message.ToModule != "MOD2" || message.ToProcedure != "PROC2" || message.ToStatement != "5678" || message.SentByUser != "USER" || message.SentTimestamp != "2026-11-13 12:34:56.123456" || message.SecondLevelText != "Help" {
		t.Fatalf("message or default: %+v", first)
	}
	if err := app.SetAppSetting("showCLMessagesInResults", "on"); err != nil {
		t.Fatal(err)
	}
	second, err := app.Run(RunRequest{ConnectionID: "one", Text: "CL: DSPJOB"})
	if err != nil {
		t.Fatal(err)
	}
	table := second.(*CLResult).ResultSet
	workspace := app.GetWorkspace("one")
	if table == nil || len(table.Columns) != 1 || table.Columns[0].Scale != 6 || len(table.Rows) != 2 || table.Rows[1][0] != nil || !workspace.ShowingResults || workspace.ResultStatement != "DSPJOB" || len(workspace.Rows) != 2 {
		t.Fatalf("table or workspace: %+v %+v", table, workspace)
	}
	if strings.Join(bridge.calls, ",") != "executeEnhancedCL,executeEnhancedCL" {
		t.Fatalf("unexpected calls: %v", bridge.calls)
	}
	if err := app.SetAppSetting("showCLMessagesInResults", "off"); err != nil || loadAppSettings().ShowCLMessagesInResults {
		t.Fatal("toggle off failed")
	}
	if err := app.SetAppSetting("showCLMessagesInResults", "invalid"); err == nil {
		t.Fatal("invalid toggle accepted")
	}
	app.connections["one"].useEnhancedCLSupport = nil
	if err := app.SetAppSetting("showCLMessagesInResults", "on"); err != nil {
		t.Fatal(err)
	}
	standard, err := app.Run(RunRequest{ConnectionID: "one", Text: "CL: DSPJOB"})
	if err != nil || standard.(*CLResult).ResultSet != nil || app.GetWorkspace("one").ShowingResults {
		t.Fatal("standard CL must not expose CMD_RUN results")
	}
	empty := decodeCLResult("CMD", map[string]any{"ok": true, "resultSet": map[string]any{"kind": "rows", "columns": []any{}, "rows": []any{}}})
	if empty.ResultSet == nil || empty.ResultSet.Rows == nil || empty.ResultSet.Columns == nil {
		t.Fatal("empty result set must be retained")
	}
}
