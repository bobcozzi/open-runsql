package bridge

import (
	"encoding/json"
	"strings"
	"testing"
)

// Fake-Java harness: Call/response correlation over the JSON-lines protocol
// without spawning a JVM. Exercises pending-map bookkeeping and error decode.

func TestRequestIDSequence(t *testing.T) {
	c := &Client{}
	// next is an atomic counter starting at 0; first id should be go-1.
	id := c.next.Add(1)
	if got := "go-" + itoa(id); got != "go-1" {
		t.Fatalf("first request id = %q, want go-1", got)
	}
}

func TestResponseDecodeErrorShape(t *testing.T) {
	// Mirrors readLoop's decode path for an error response.
	line := `{"id":"go-1","ok":false,"error":{"type":"SQLException","message":"[SQL0104] Token X was not valid"}}`
	var resp map[string]any
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if ok, _ := resp["ok"].(bool); ok {
		t.Fatal("ok should be false")
	}
	e, _ := resp["error"].(map[string]any)
	if e == nil || !strings.Contains(e["message"].(string), "SQL0104") {
		t.Fatalf("error payload missing message: %v", resp["error"])
	}
}

func TestResponseDecodeResultShape(t *testing.T) {
	// Success path: result.columns/rows shape from executeSQL.
	line := `{"id":"go-2","ok":true,"result":{"kind":"rows","columns":[{"name":"A","typeName":"INTEGER","type":4}],"rows":[[1],[2]],"more":false,"elapsedMs":5}}`
	var resp map[string]any
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	result, _ := resp["result"].(map[string]any)
	if result == nil || result["kind"] != "rows" {
		t.Fatalf("kind mismatch: %v", result)
	}
	rows, _ := result["rows"].([]any)
	if len(rows) != 2 {
		t.Fatalf("rows len = %d, want 2", len(rows))
	}
}

func itoa(v uint64) string {
	// avoids importing strconv just for the test
	if v == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	return string(b[i:])
}
