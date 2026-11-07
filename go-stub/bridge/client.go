package bridge

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
)

type Client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	reader *bufio.Reader
	writeMu sync.Mutex
	pendingMu sync.Mutex
	pending map[string]chan map[string]any
	next atomic.Uint64
	done chan struct{}
}

func Start(javaPath, jarPath string) (*Client, error) {
	if javaPath == "" { javaPath = "java" }
	cmd := exec.Command(javaPath, "-jar", jarPath)
	cmd.Stderr = os.Stderr
	in, err := cmd.StdinPipe(); if err != nil { return nil, err }
	out, err := cmd.StdoutPipe(); if err != nil { return nil, err }
	if err = cmd.Start(); err != nil { return nil, err }
	c := &Client{cmd: cmd, stdin: in, reader: bufio.NewReader(out),
		pending: make(map[string]chan map[string]any), done: make(chan struct{})}
	go c.readLoop()
	return c, nil
}

func (c *Client) readLoop() {
	defer close(c.done)
	for {
		line, err := c.reader.ReadBytes('\n')
		if err != nil { break }
		var response map[string]any
		if json.Unmarshal(line, &response) != nil { continue }
		id, _ := response["id"].(string)
		c.pendingMu.Lock()
		ch := c.pending[id]
		delete(c.pending, id)
		c.pendingMu.Unlock()
		if ch != nil { ch <- response; close(ch) }
	}
	c.pendingMu.Lock()
	for id, ch := range c.pending {
		ch <- map[string]any{"id": id, "ok": false, "error": map[string]any{"message": "Java bridge process ended"}}
		close(ch)
		delete(c.pending, id)
	}
	c.pendingMu.Unlock()
}

func (c *Client) Call(op string, fields map[string]any) (map[string]any, error) {
	id := fmt.Sprintf("go-%d", c.next.Add(1))
	req := map[string]any{"id": id, "op": op}
	for k, v := range fields { req[k] = v }
	ch := make(chan map[string]any, 1)
	c.pendingMu.Lock(); c.pending[id] = ch; c.pendingMu.Unlock()

	data, err := json.Marshal(req)
	if err != nil { return nil, err }
	c.writeMu.Lock()
	_, err = c.stdin.Write(append(data, '\n'))
	c.writeMu.Unlock()
	if err != nil {
		c.pendingMu.Lock(); delete(c.pending, id); c.pendingMu.Unlock()
		return nil, err
	}
	response := <-ch
	if ok, _ := response["ok"].(bool); !ok {
		return response, errors.New(fmt.Sprint(response["error"]))
	}
	return response, nil
}

func (c *Client) Close() error {
	_, _ = c.Call("shutdown", nil)
	_ = c.stdin.Close()
	<-c.done
	return c.cmd.Wait()
}
