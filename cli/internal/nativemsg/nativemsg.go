// Package nativemsg implements Firefox native messaging framing: a uint32
// length header in native byte order followed by a UTF-8 JSON payload.
package nativemsg

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

const (
	// MaxInbound caps extension->host payloads. The spec allows 4 GB; the
	// project cap is sized for a stopHar reply, which the extension fits
	// below it, and still bounds what a buggy build can make the host
	// allocate.
	MaxInbound = 256 * 1024 * 1024
	// MaxOutbound is the Firefox limit for host->extension payloads.
	MaxOutbound = 1024 * 1024

	headerSize = 4
)

// ErrTooLarge reports a payload above the direction's size cap.
var ErrTooLarge = errors.New("message too large")

// SizeError is the ErrTooLarge a Writer reports: the frame was refused before
// any byte was written, so the stream stays usable.
type SizeError struct {
	Size int
	Max  int
}

func (e *SizeError) Error() string {
	return fmt.Sprintf("%v: %d bytes (max %d)", ErrTooLarge, e.Size, e.Max)
}

// Is makes errors.Is(err, ErrTooLarge) hold for a SizeError.
func (e *SizeError) Is(target error) bool {
	return target == ErrTooLarge
}

// Reader decodes frames from an io.Reader. Cancellation is the caller's job:
// close the underlying reader to unblock a pending Read.
type Reader struct {
	r      io.Reader
	limit  uint32
	header [headerSize]byte
}

// NewReader returns a Reader over r that refuses payloads above MaxInbound.
func NewReader(r io.Reader) *Reader {
	return NewReaderLimit(r, MaxInbound)
}

// NewReaderLimit returns a Reader over r that refuses payloads above limit.
func NewReaderLimit(r io.Reader, limit uint32) *Reader {
	return &Reader{r: r, limit: limit}
}

// Read returns the next payload. It reports io.EOF on a frame boundary and
// io.ErrUnexpectedEOF when the stream ends mid-frame. A payload above the
// limit is discarded and reported as ErrTooLarge; the stream stays usable.
func (r *Reader) Read() (json.RawMessage, error) {
	if _, err := io.ReadFull(r.r, r.header[:]); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, io.EOF
		}

		return nil, fmt.Errorf("read header: %w", err)
	}

	length := binary.NativeEndian.Uint32(r.header[:])
	if length == 0 {
		return json.RawMessage("{}"), nil
	}

	if length > r.limit {
		return nil, r.discard(length)
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(r.r, payload); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}

		return nil, fmt.Errorf("read payload: %w", err)
	}

	return payload, nil
}

// discard drops an oversize payload so the next frame starts on a boundary.
func (r *Reader) discard(length uint32) error {
	if _, err := io.CopyN(io.Discard, r.r, int64(length)); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}

		return fmt.Errorf("discard oversize payload: %w", err)
	}

	return fmt.Errorf("%w: %d bytes (max %d)", ErrTooLarge, length, r.limit)
}

// Writer encodes values as frames. It is safe for concurrent use.
type Writer struct {
	mu sync.Mutex
	w  io.Writer
}

// NewWriter returns a Writer over w.
func NewWriter(w io.Writer) *Writer {
	return &Writer{w: w}
}

// Write marshals v and emits one frame.
func (w *Writer) Write(v any) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal message: %w", err)
	}

	if len(payload) > MaxOutbound {
		return &SizeError{Size: len(payload), Max: MaxOutbound}
	}

	frame := make([]byte, headerSize+len(payload))
	//nolint:gosec // len(payload) is capped at MaxOutbound above
	binary.NativeEndian.PutUint32(frame[:headerSize], uint32(len(payload)))
	copy(frame[headerSize:], payload)

	w.mu.Lock()
	defer w.mu.Unlock()

	if err := writeFull(w.w, frame); err != nil {
		return fmt.Errorf("write frame: %w", err)
	}

	return nil
}

// writeFull keeps writing until the whole frame is out: a partial write would
// desynchronise the framing for every later message.
func writeFull(w io.Writer, frame []byte) error {
	for len(frame) > 0 {
		n, err := w.Write(frame)
		if err != nil {
			return err
		}

		if n <= 0 {
			return io.ErrShortWrite
		}

		frame = frame[n:]
	}

	return nil
}
