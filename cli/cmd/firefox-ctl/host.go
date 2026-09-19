package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"firefox-ctl/internal/host"
	"firefox-ctl/internal/ipc"
)

// hostConfig carries everything the host mode touches outside itself, so tests
// can drive the lifecycle without real signals or real stdio.
type hostConfig struct {
	socket  string
	signals <-chan os.Signal
	stdin   io.Reader
	stdout  io.Writer
	logger  *log.Logger
}

func newHostCmd(opts *rootOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "host",
		Short: "Run as the Firefox native messaging host",
		Args:  usageArgs(cobra.NoArgs),
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runHost(cmd.Context(), hostConfig{socket: opts.socket})
		},
	}
}

// runHost listens on the socket and bridges CLI clients to the extension until
// stdin reaches EOF, a termination signal arrives or the bridge fails.
func runHost(ctx context.Context, cfg hostConfig) error {
	cfg.applyDefaults()

	path, err := resolveSocket(cfg.socket)
	if err != nil {
		return err
	}

	ln, err := ipc.Listen(path)
	if err != nil {
		return err
	}

	defer func() { _ = ln.Close() }()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	go func() {
		select {
		case sig := <-cfg.signals:
			cfg.logger.Printf("received %v, shutting down", sig)
			cancel()
		case <-ctx.Done():
		}
	}()

	srv := host.NewServer(&host.Options{Logger: cfg.logger, Version: version})

	cfg.logger.Printf("listening on %s", path)

	if err := srv.Run(ctx, ln, cfg.stdin, cfg.stdout); err != nil {
		return fmt.Errorf("host: %w", err)
	}

	return nil
}

func (c *hostConfig) applyDefaults() {
	if c.signals == nil {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
		c.signals = ch
	}

	if c.stdin == nil {
		c.stdin = os.Stdin
	}

	if c.stdout == nil {
		c.stdout = os.Stdout
	}

	if c.logger == nil {
		c.logger = log.New(os.Stderr, "[firefox-ctl-host] ", log.LstdFlags)
	}
}
