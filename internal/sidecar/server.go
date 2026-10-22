// Package sidecar is the moejs-ptc process. It runs dsh PTC programs, each in
// a fresh moejs runtime, and talks to its host over JSON lines: frames from
// the host on stdin, frames to the host on stdout, one JSON object per line.
//
// Host to sidecar:
//
//	{"type":"boot","protocol":1,"memoryLimitBytes":N,"maxLogBytes":N,"maxValueBytes":N,"maxPendingCalls":N,"maxFrameBytes":N}
//	{"type":"run","run":R,"program":"...","namespaces":[{"global":"tools","names":["bash"],"errorClass":{"name":"ToolCallError","memberNameProperty":"toolName"}}]}
//	{"type":"reply","run":R,"id":N,"ok":true,"value":<json>}
//	{"type":"reply","run":R,"id":N,"ok":false,"message":"..."}
//	{"type":"cancel","run":R}
//
// Sidecar to host:
//
//	{"type":"boot-ack","protocol":1}
//	{"type":"call","run":R,"id":N,"global":"tools","name":"bash","args":<json>}
//	{"type":"log","run":R,"text":"..."}
//	{"type":"log","run":R,"text":"...","truncated":true}
//	{"type":"done","run":R}
//	{"type":"done","run":R,"value":<json>}
//	{"type":"done","run":R,"error":{"kind":"exception","message":"..."}}
//
// Call ids count from 1 in each run. After a cancel the sidecar stops sending
// frames for that run. A cancel and a frame can cross on the wire, so each
// side drops frames for a run that has ended. Closing stdin cancels every run
// and ends the process.
package sidecar

import (
	"bufio"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
	"time"

	"github.com/Calcium-Ion/moejs"
)

// Protocol is the wire version the host and the sidecar must agree on.
const Protocol = 1

// frameEnvelope is room for the fields around a value in one frame.
const frameEnvelope = 256

// shutdownWait bounds how long the sidecar waits for cancelled runs on exit.
// An interrupt stops a run within microseconds. A compile in progress runs to
// its end and can take longer.
const shutdownWait = 2 * time.Second

//go:embed prelude.js
var preludeSource string

// Config holds the budgets of the boot frame.
type Config struct {
	MemoryLimitBytes int64 `json:"memoryLimitBytes"`
	MaxLogBytes      int   `json:"maxLogBytes"`
	MaxValueBytes    int   `json:"maxValueBytes"`
	MaxPendingCalls  int   `json:"maxPendingCalls"`
	MaxFrameBytes    int   `json:"maxFrameBytes"`
}

func (c Config) validate() error {
	if c.MemoryLimitBytes <= 0 || c.MaxLogBytes <= 0 || c.MaxValueBytes <= 0 || c.MaxPendingCalls <= 0 || c.MaxFrameBytes <= frameEnvelope {
		return errors.New("boot frame budgets must be positive")
	}
	if c.MaxLogBytes > c.MaxFrameBytes-frameEnvelope || c.MaxValueBytes > c.MaxFrameBytes-frameEnvelope {
		return errors.New("maxLogBytes and maxValueBytes must fit in a frame")
	}
	return nil
}

// Namespace is one binding namespace of a run frame.
type Namespace struct {
	Global     string      `json:"global"`
	Names      []string    `json:"names"`
	ErrorClass *ErrorClass `json:"errorClass,omitempty"`
}

// ErrorClass is a namespace's program-visible rejection class.
type ErrorClass struct {
	Name               string `json:"name"`
	MemberNameProperty string `json:"memberNameProperty"`
}

type inFrame struct {
	Type     string `json:"type"`
	Protocol int    `json:"protocol"`
	Config
	Run        uint64          `json:"run"`
	ID         uint64          `json:"id"`
	OK         bool            `json:"ok"`
	Value      json.RawMessage `json:"value"`
	Message    string          `json:"message"`
	Program    string          `json:"program"`
	Namespaces []Namespace     `json:"namespaces"`
}

// Serve runs the sidecar until in ends or a frame is malformed.
func Serve(in io.Reader, out io.Writer) error {
	prelude, err := moejs.CompileScript("prelude.js", preludeSource)
	if err != nil {
		return fmt.Errorf("prelude: %w", err)
	}
	reader := bufio.NewReaderSize(in, 64<<10)
	line, err := readLine(reader, 64<<10)
	if err != nil {
		return fmt.Errorf("reading the boot frame: %w", err)
	}
	var boot inFrame
	if err := json.Unmarshal(line, &boot); err != nil || boot.Type != "boot" {
		return errors.New("the first frame must be a boot frame")
	}
	if boot.Protocol != Protocol {
		return fmt.Errorf("protocol %d requested, this sidecar speaks %d", boot.Protocol, Protocol)
	}
	if err := boot.Config.validate(); err != nil {
		return err
	}
	s := &server{cfg: boot.Config, prelude: prelude, out: &writer{w: bufio.NewWriterSize(out, 64<<10)}, runs: map[uint64]*run{}}
	s.out.write(fmt.Appendf(nil, "{\"type\":\"boot-ack\",\"protocol\":%d}\n", Protocol))
	defer s.shutdown()
	for {
		line, err := readLine(reader, s.cfg.MaxFrameBytes)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		var f inFrame
		if err := json.Unmarshal(line, &f); err != nil {
			return fmt.Errorf("malformed frame: %w", err)
		}
		switch f.Type {
		case "run":
			if err := s.start(f); err != nil {
				return err
			}
		case "reply":
			if r := s.lookup(f.Run); r != nil {
				r.deliver(reply{id: f.ID, ok: f.OK, value: f.Value, message: f.Message})
			}
		case "cancel":
			if r := s.lookup(f.Run); r != nil {
				r.cancel()
			}
		default:
			return fmt.Errorf("unknown frame type %q", f.Type)
		}
	}
}

type server struct {
	cfg     Config
	prelude *moejs.Script
	out     *writer
	mu      sync.Mutex
	runs    map[uint64]*run
	wg      sync.WaitGroup
}

func (s *server) start(f inFrame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if f.Run == 0 || s.runs[f.Run] != nil {
		return fmt.Errorf("run id %d is zero or already in use", f.Run)
	}
	r := newRun(s, f.Run, f.Program, f.Namespaces)
	s.runs[f.Run] = r
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		r.execute()
		s.forget(r.id)
	}()
	return nil
}

// forget drops a run before its last frame, so a frame for it that crosses
// that one on the wire finds nothing.
func (s *server) forget(id uint64) {
	s.mu.Lock()
	delete(s.runs, id)
	s.mu.Unlock()
}

func (s *server) lookup(id uint64) *run {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs[id]
}

func (s *server) shutdown() {
	s.mu.Lock()
	for _, r := range s.runs {
		r.cancel()
	}
	s.mu.Unlock()
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(shutdownWait):
	}
}

// readLine returns the next line without its newline. The slice is valid
// until the next read.
func readLine(r *bufio.Reader, max int) ([]byte, error) {
	var long []byte
	for {
		chunk, err := r.ReadSlice('\n')
		if len(long)+len(chunk) > max+1 {
			return nil, fmt.Errorf("frame longer than %d bytes", max)
		}
		switch {
		case err == nil && long == nil:
			return chunk[:len(chunk)-1], nil
		case err == nil:
			long = append(long, chunk...)
			return long[:len(long)-1], nil
		case errors.Is(err, bufio.ErrBufferFull):
			long = append(long, chunk...)
		case errors.Is(err, io.EOF) && len(long)+len(chunk) == 0:
			return nil, io.EOF
		default:
			return nil, fmt.Errorf("reading a frame: %w", err)
		}
	}
}

// writer serializes frames from all runs onto stdout.
type writer struct {
	mu  sync.Mutex
	w   *bufio.Writer
	err error
}

func (w *writer) write(frame []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return
	}
	if _, err := w.w.Write(frame); err != nil {
		w.err = err
		return
	}
	w.err = w.w.Flush()
}

// frameStart begins the frame {"type":typ,"run":run.
func frameStart(dst []byte, typ string, run uint64) []byte {
	dst = append(dst, `{"type":"`...)
	dst = append(dst, typ...)
	dst = append(dst, `","run":`...)
	return strconv.AppendUint(dst, run, 10)
}
