package bridge

import (
	"bufio"
	"encoding/json"
	"io"
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

func TestReadLoopDispatchesEventsWithoutConsumingResponses(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	events := make(chan map[string]any, 1)
	responses := make(chan map[string]any, 1)
	client := &Client{
		reader:  bufio.NewReader(reader),
		pending: map[string]chan map[string]any{"go-1": responses},
		done:    make(chan struct{}),
	}
	client.alive.Store(true)
	client.SetEventHandler(func(event map[string]any) { events <- event })
	go client.readLoop()
	if _, err := io.WriteString(writer, `{"event":"enhancedSupportProgress","connectionId":"conn-1"}`+"\n"+`{"id":"go-1","ok":true}`+"\n"); err != nil {
		t.Fatalf("write protocol lines: %v", err)
	}
	_ = writer.Close()

	if event := <-events; event["event"] != "enhancedSupportProgress" || event["connectionId"] != "conn-1" {
		t.Fatalf("unexpected event: %#v", event)
	}
	if response := <-responses; response["id"] != "go-1" || response["ok"] != true {
		t.Fatalf("unexpected response: %#v", response)
	}
	<-client.done
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
