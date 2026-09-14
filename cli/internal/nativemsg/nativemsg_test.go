package nativemsg

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"testing/iotest"
)

// frame builds a length-prefixed frame the way Firefox does.
func frame(payload string) []byte {
	//nolint:gosec // test payloads are a few bytes
	return append(header(uint32(len(payload))), payload...)
}

func header(length uint32) []byte {
	b := make([]byte, 4)
	binary.NativeEndian.PutUint32(b, length)

	return b
}

func TestReaderFrames(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input []byte
		wrap  func(io.Reader) io.Reader
		want  []string
	}{
		{
			name:  "single frame",
			input: frame(`{"id":"1","command":"ping"}`),
			want:  []string{`{"id":"1","command":"ping"}`},
		},
		{
			name:  "two frames in one buffer",
			input: append(frame(`{"a":1}`), frame(`{"b":2}`)...),
			want:  []string{`{"a":1}`, `{"b":2}`},
		},
		{
			name:  "frame split across reads",
			input: append(frame(`{"a":1}`), frame(`{"b":2}`)...),
			wrap:  iotest.OneByteReader,
			want:  []string{`{"a":1}`, `{"b":2}`},
		},
		{
			name:  "zero length frame reads as empty object",
			input: append(frame(""), frame(`{"a":1}`)...),
			want:  []string{`{}`, `{"a":1}`},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var src io.Reader = bytes.NewReader(tt.input)
			if tt.wrap != nil {
				src = tt.wrap(src)
			}

			r := NewReader(src)
			for i, want := range tt.want {
				got, err := r.Read()
				if err != nil {
					t.Fatalf("frame %d: unexpected error: %v", i, err)
				}
				if string(got) != want {
					t.Errorf("frame %d = %q, want %q", i, got, want)
				}
			}

			if _, err := r.Read(); !errors.Is(err, io.EOF) {
				t.Errorf("after last frame err = %v, want io.EOF", err)
			}
		})
	}
}

func TestReaderErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input []byte
		want  error
	}{
		{
			name:  "clean eof on empty stream",
			input: nil,
			want:  io.EOF,
		},
		{
			name:  "partial header",
			input: []byte{0x01, 0x02},
			want:  io.ErrUnexpectedEOF,
		},
		{
			name:  "partial payload",
			input: append(header(16), []byte(`{"a":1}`)...),
			want:  io.ErrUnexpectedEOF,
		},
		{
			name:  "oversize length",
			input: header(MaxInbound + 1),
			want:  ErrTooLarge,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			r := NewReader(bytes.NewReader(tt.input))

			got, err := r.Read()
			if !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
			if got != nil {
				t.Errorf("payload = %q, want nil", got)
			}
		})
	}
}

func TestReaderPropagatesReadError(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("boom")
	r := NewReader(iotest.ErrReader(sentinel))

	if _, err := r.Read(); !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want %v", err, sentinel)
	}
}

func TestWriterRoundTrip(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	w := NewWriter(&buf)

	sent := map[string]any{"id": "abc", "type": "command", "command": "ping"}
	if err := w.Write(sent); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := NewReader(&buf).Read()
	if err != nil {
		t.Fatalf("read: %v", err)
	}

	var back map[string]any
	if err := json.Unmarshal(got, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for k, v := range sent {
		if back[k] != v {
			t.Errorf("field %q = %v, want %v", k, back[k], v)
		}
	}
}

func TestWriterRejectsOversizePayload(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	w := NewWriter(&buf)

	err := w.Write(map[string]string{"big": strings.Repeat("x", MaxOutbound)})
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if buf.Len() != 0 {
		t.Errorf("wrote %d bytes, want nothing", buf.Len())
	}
}

func TestWriterRejectsUnmarshalableValue(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer

	if err := NewWriter(&buf).Write(make(chan int)); err == nil {
		t.Fatal("want error for unmarshalable value")
	}
}

func TestWriterConcurrentWritesStayIntact(t *testing.T) {
	t.Parallel()

	const writers = 32

	var buf bytes.Buffer

	w := NewWriter(&syncWriter{w: &buf})

	var wg sync.WaitGroup
	for i := range writers {
		wg.Add(1)

		go func() {
			defer wg.Done()

			if err := w.Write(map[string]int{"n": i}); err != nil {
				t.Errorf("write %d: %v", i, err)
			}
		}()
	}

	wg.Wait()

	seen := make(map[int]bool, writers)
	r := NewReader(&buf)

	for range writers {
		payload, err := r.Read()
		if err != nil {
			t.Fatalf("read: %v", err)
		}

		var msg struct {
			N int `json:"n"`
		}
		if err := json.Unmarshal(payload, &msg); err != nil {
			t.Fatalf("unmarshal %q: %v", payload, err)
		}

		seen[msg.N] = true
	}

	if len(seen) != writers {
		t.Errorf("decoded %d distinct frames, want %d", len(seen), writers)
	}
	if _, err := r.Read(); !errors.Is(err, io.EOF) {
		t.Errorf("trailing bytes after %d frames: err = %v", writers, err)
	}
}

func TestWriterCompletesShortWrites(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	w := NewWriter(&oneByteWriter{w: &buf})

	if err := w.Write(map[string]string{"command": "ping"}); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := NewReader(&buf).Read()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != `{"command":"ping"}` {
		t.Errorf("payload = %q", got)
	}
}

func TestWriterWrapsWriteFailures(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("pipe closed")

	tests := []struct {
		name  string
		after int
	}{
		{name: "fails on header", after: 0},
		{name: "fails mid payload", after: 6},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			w := NewWriter(&failingWriter{after: tt.after, err: sentinel})

			err := w.Write(map[string]string{"command": "ping"})
			if !errors.Is(err, sentinel) {
				t.Fatalf("err = %v, want %v", err, sentinel)
			}
			if !strings.Contains(err.Error(), "write frame") {
				t.Errorf("err = %q, want it wrapped with context", err)
			}
		})
	}
}

func TestWriterReportsShortWriteWithoutError(t *testing.T) {
	t.Parallel()

	err := NewWriter(&stalledWriter{}).Write(map[string]string{"command": "ping"})
	if !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("err = %v, want io.ErrShortWrite", err)
	}
}

// syncWriter serialises nothing on purpose: it only makes the race detector
// see the shared buffer through a single mutex, so any interleaving comes from
// the Writer itself.
type syncWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (s *syncWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.w.Write(p)
}

type oneByteWriter struct{ w io.Writer }

func (o *oneByteWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}

	return o.w.Write(p[:1])
}

type failingWriter struct {
	after int
	n     int
	err   error
}

func (f *failingWriter) Write(p []byte) (int, error) {
	if f.n >= f.after {
		return 0, f.err
	}

	allowed := min(len(p), f.after-f.n)
	f.n += allowed

	return allowed, nil
}

type stalledWriter struct{}

func (s *stalledWriter) Write(_ []byte) (int, error) { return 0, nil }
