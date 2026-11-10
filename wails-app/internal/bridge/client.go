// Package bridge supervises the Java JTOpen/JDBC helper process and speaks
// its JSON-lines protocol over stdin/stdout. It is a copy of the starter's
// go-stub client with liveness tracking added.
package bridge

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
)

type Client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	reader *bufio.Reader

	writeMu   sync.Mutex
	pendingMu sync.Mutex
	pending   map[string]chan map[string]any
	next      atomic.Uint64
	done      chan struct{}
	alive     atomic.Bool
}

func Start(javaPath, jarPath string) (*Client, error) {
	if javaPath == "" {
		javaPath = os.Getenv("IBMI_JAVA")
	}
	if javaPath == "" {
		javaPath = "java"
	}
	cmd := exec.Command(javaPath, "-jar", jarPath)
	// Force IPv4: the JVM's default IPv6-mapped sockets on macOS can return
	// instant EHOSTUNREACH ("No route to host") during scoped-route/Wi-Fi
	// blips while plain IPv4 processes connect fine.
	cmd.Args = append([]string{cmd.Args[0], "-Djava.net.preferIPv4Stack=true"}, cmd.Args[1:]...)
	// Launching via `open` drops the app's stderr, taking the bridge's with
	// it — JT400's real exception lands nowhere. Tee it to a log file instead,
	// and tell the bridge where JT400's own Trace output should go.
	if dir, err := os.UserCacheDir(); err == nil {
		logPath := filepath.Join(dir, "ibmi-runsql", "bridge-stderr.log")
		if logFile, err := os.OpenFile(logPath,
			os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
			cmd.Stderr = logFile
			cmd.Env = append(os.Environ(), "IBMI_BRIDGE_TRACE_LOG="+logPath)
		} else {
			cmd.Stderr = os.Stderr
		}
	} else {
		cmd.Stderr = os.Stderr
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	c := &Client{
		cmd:     cmd,
		stdin:   in,
		reader:  bufio.NewReader(out),
		pending: make(map[string]chan map[string]any),
		done:    make(chan struct{}),
	}
	c.alive.Store(true)
	go c.readLoop()
	return c, nil
}

func (c *Client) Alive() bool { return c.alive.Load() }

func (c *Client) readLoop() {
	defer close(c.done)
	for {
		line, err := c.reader.ReadBytes('\n')
		if err != nil {
			break
		}
		var response map[string]any
		if json.Unmarshal(line, &response) != nil {
			continue
		}
		id, _ := response["id"].(string)
		c.pendingMu.Lock()
		ch := c.pending[id]
		delete(c.pending, id)
		c.pendingMu.Unlock()
		if ch != nil {
			ch <- response
			close(ch)
		}
	}
	c.alive.Store(false)
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
	for k, v := range fields {
		req[k] = v
	}
	ch := make(chan map[string]any, 1)
	c.pendingMu.Lock()
	c.pending[id] = ch
	c.pendingMu.Unlock()

	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	c.writeMu.Lock()
	_, err = c.stdin.Write(append(data, '\n'))
	c.writeMu.Unlock()
	if err != nil {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, err
	}
	response := <-ch
	if ok, _ := response["ok"].(bool); !ok {
		if e, ok := response["error"].(map[string]any); ok {
			if msg, ok := e["message"].(string); ok {
				detail := ""
				if et, _ := e["type"].(string); et != "" {
					detail = " [" + et
					if ct, _ := e["causeType"].(string); ct != "" {
						cm, _ := e["causeMessage"].(string)
						detail += "; cause " + ct + ": " + cm
					}
					if hm, _ := e["hostMessages"].(string); hm != "" {
						detail += "; host: " + hm
					}
					detail += "]"
				}
				return response, fmt.Errorf("%s%s", msg, detail)
			}
		}
		return response, fmt.Errorf("bridge operation %s failed", op)
	}
	return response, nil
}

func (c *Client) Close() error {
	_, _ = c.Call("shutdown", nil)
	_ = c.stdin.Close()
	<-c.done
	return c.cmd.Wait()
}
