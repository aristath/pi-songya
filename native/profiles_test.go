package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestProfileProvisioningCreatesOnlyItsOwnStoreAndReadsDoNotInitialize(t *testing.T) {
	root := t.TempDir()
	first, second := filepath.Join(root, "first", "memories"), filepath.Join(root, "second", "memories")
	q := request{Store: first, User: "first", Operation: "type_configuration", Args: json.RawMessage(`{}`)}
	if reply := handle(context.Background(), q); reply.Error == "" {
		t.Fatal("missing store was treated as readable")
	}
	if _, err := os.Stat(first); !os.IsNotExist(err) {
		t.Fatal("a read initialized a missing store")
	}
	q.Operation = "initialize_store"
	if reply := handle(context.Background(), q); reply.Error != "" {
		t.Fatal(reply.Error)
	}
	if _, err := os.Stat(first); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(second); !os.IsNotExist(err) {
		t.Fatal("another profile was initialized")
	}
	q.Operation = "type_configuration"
	if reply := handle(context.Background(), q); reply.Error != "" {
		t.Fatal(reply.Error)
	}
	if _, err := os.Stat(second); !os.IsNotExist(err) {
		t.Fatal("another profile was read or created")
	}
}
