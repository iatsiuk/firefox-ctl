package nativemsg

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
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

func TestMaxInboundFitsStopHar(t *testing.T) {
	t.Parallel()

	if MaxInbound != 256*1024*1024 {
		t.Fatalf("MaxInbound = %d, want 256 MiB", MaxInbound)
	}
}

func TestNewReaderDefaultsToMaxInbound(t *testing.T) {
	t.Parallel()

	input := io.MultiReader(bytes.NewReader(header(MaxInbound+1)), filler(MaxInbound+1),
		bytes.NewReader(frame(`{"a":1}`)))
	r := NewReader(input)

	if _, err := r.Read(); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize frame err = %v, want ErrTooLarge", err)
	}

	got, err := r.Read()
	if err != nil || string(got) != `{"a":1}` {
		t.Fatalf("next frame = %q, %v; want {\"a\":1}", got, err)
	}
}

func TestReaderDiscardsOversizeFrame(t *testing.T) {
	t.Parallel()

	const limit = 16

	tests := []struct {
		name  string
		input func() io.Reader
		want  []error
	}{
		{
			name: "oversize frame then a normal one",
			input: func() io.Reader {
				return lazyFrames(oversize(limit+1), normal(`{"a":1}`))
			},
			want: []error{ErrTooLarge, nil},
		},
		{
			name: "two oversize frames then a normal one",
			input: func() io.Reader {
				return lazyFrames(oversize(limit+1), oversize(1<<20), normal(`{"a":1}`))
			},
			want: []error{ErrTooLarge, ErrTooLarge, nil},
		},
		{
			name: "frame at the limit is read",
			input: func() io.Reader {
				return lazyFrames(normal(`{"a":"0123456"}`), normal(`{"a":1}`))
			},
			want: []error{nil, nil},
		},
		{
			name: "split across one byte reads",
			input: func() io.Reader {
				return iotest.OneByteReader(lazyFrames(oversize(limit+1), normal(`{"a":1}`)))
			},
			want: []error{ErrTooLarge, nil},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			r := NewReaderLimit(tt.input(), limit)

			for i, want := range tt.want {
				got, err := r.Read()
				if want != nil {
					if !errors.Is(err, want) || got != nil {
						t.Fatalf("frame %d = %q, %v; want nil, %v", i, got, err, want)
					}

					continue
				}

				if err != nil {
					t.Fatalf("frame %d: unexpected error: %v", i, err)
				}
				if !json.Valid(got) {
					t.Errorf("frame %d = %q, want intact JSON", i, got)
				}
			}

			if _, err := r.Read(); !errors.Is(err, io.EOF) {
				t.Errorf("after last frame err = %v, want io.EOF", err)
			}
		})
	}
}

func TestReaderOversizeErrorText(t *testing.T) {
	t.Parallel()

	r := NewReaderLimit(lazyFrames(oversize(17)), 16)

	_, err := r.Read()
	if err == nil || err.Error() != "message too large: 17 bytes (max 16)" {
		t.Fatalf("err = %v, want the size and the limit", err)
	}
}

func TestReaderOversizeFrameCutShort(t *testing.T) {
	t.Parallel()

	const limit = 16

	tests := []struct {
		name  string
		input io.Reader
	}{
		{
			name:  "stream ends inside the discarded payload",
			input: io.MultiReader(bytes.NewReader(header(1024)), filler(100)),
		},
		{
			name:  "stream ends right after the oversize header",
			input: bytes.NewReader(header(1024)),
		},
		{
			name:  "one byte reads ending inside the payload",
			input: iotest.OneByteReader(io.MultiReader(bytes.NewReader(header(1024)), filler(1023))),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			_, err := NewReaderLimit(tt.input, limit).Read()
			if !errors.Is(err, io.ErrUnexpectedEOF) {
				t.Fatalf("err = %v, want io.ErrUnexpectedEOF", err)
			}
			if errors.Is(err, io.EOF) || errors.Is(err, ErrTooLarge) {
				t.Errorf("err = %v also matches io.EOF or ErrTooLarge", err)
			}
		})
	}
}

func TestReaderOversizeDiscardPropagatesReadError(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("boom")
	input := io.MultiReader(bytes.NewReader(header(1024)), filler(10), iotest.ErrReader(sentinel))

	_, err := NewReaderLimit(input, 16).Read()
	if !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want %v", err, sentinel)
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

func TestWriterOversizeErrorCarriesSize(t *testing.T) {
	t.Parallel()

	payload := map[string]string{"big": strings.Repeat("x", MaxOutbound)}
	want := len(`{"big":""}`) + MaxOutbound

	err := NewWriter(&bytes.Buffer{}).Write(payload)

	var sizeErr *SizeError
	if !errors.As(err, &sizeErr) {
		t.Fatalf("err = %v, want *SizeError", err)
	}

	if sizeErr.Size != want || sizeErr.Max != MaxOutbound {
		t.Errorf("SizeError = %+v, want Size %d, Max %d", sizeErr, want, MaxOutbound)
	}

	wantText := fmt.Sprintf("message too large: %d bytes (max %d)", want, MaxOutbound)
	if err.Error() != wantText {
		t.Errorf("text = %q, want %q", err.Error(), wantText)
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

// lazyFrames joins frame parts without materialising oversize payloads.
func lazyFrames(parts ...io.Reader) io.Reader {
	return io.MultiReader(parts...)
}

// oversize is a frame header followed by length filler bytes generated on
// demand.
func oversize(length uint32) io.Reader {
	return io.MultiReader(bytes.NewReader(header(length)), filler(int64(length)))
}

func normal(payload string) io.Reader {
	return bytes.NewReader(frame(payload))
}

// filler yields n bytes of 'x' without allocating them.
func filler(n int64) io.Reader {
	return io.LimitReader(fillReader{}, n)
}

var fillBlock = bytes.Repeat([]byte("x"), 32*1024)

type fillReader struct{}

func (fillReader) Read(p []byte) (int, error) {
	n := 0
	for n < len(p) {
		n += copy(p[n:], fillBlock)
	}

	return n, nil
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
