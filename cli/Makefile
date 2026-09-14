BINARY := firefox-ctl
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-s -w -X main.version=$(VERSION)"
COVER_MIN := 80

.PHONY: build test cover lint clean install release-check release-snapshot

build: lint
	go build $(LDFLAGS) -o $(BINARY) ./cmd/firefox-ctl

test:
	go test -v -race -coverprofile=coverage.out ./...

# cover.sh also fails on FAIL lines: the pipe hides the go test exit status
cover:
	go test -covermode=atomic -coverprofile=coverage.out ./... | sh scripts/cover.sh $(COVER_MIN)

lint:
	golangci-lint run

clean:
	rm -f $(BINARY) coverage.out
	rm -rf dist

release-check:
	goreleaser check

release-snapshot:
	goreleaser release --snapshot --clean

install:
	go install $(LDFLAGS) ./cmd/firefox-ctl
