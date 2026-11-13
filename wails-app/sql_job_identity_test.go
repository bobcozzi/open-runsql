package main

import "testing"

func TestConnectionIdentityRetainsSQLJob(t *testing.T) {
	bridge := &fakeEnhancedBridge{handle: func(op string, fields map[string]any) (map[string]any, error) {
		return map[string]any{"connectionId": "test", "serverJob": "123456/QUSER/QZDASOINIT"}, nil
	}}
	app := NewApp("")
	app.client = bridge
	result, err := app.Connect(ConnectRequest{Host: "host", User: "user"})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := app.GetConnectionIdentity(result.ConnectionID)
	if err != nil || identity.ServerJob != "123456/QUSER/QZDASOINIT" || result.ServerJob != identity.ServerJob {
		t.Fatalf("identity=%+v result=%+v err=%v", identity, result, err)
	}
}
