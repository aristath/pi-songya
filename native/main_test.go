package main

import (
	"bytes"
	"context"
	"encoding/json"
	stdimage "image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/aristath/songya"
)

type fixture struct {
	t     *testing.T
	store *songya.Store
	root  string
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Deterministic embedding double; no request can reach a live provider.
		if r.URL.Path != "/v1/embeddings" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"embedding": []float64{1, 0, 0}, "index": 0}}})
	}))
	t.Cleanup(provider.Close)
	root := t.TempDir()
	s, err := songya.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	config := map[string]any{"embeddings": map[string]any{"model": "controlled-fixture", "base_url": provider.URL + "/v1", "chunk_size": 512}, "recall": map[string]any{"min_score": 0, "direct_limit": 20, "connected_limit": 20}}
	data, _ := json.Marshal(config)
	if err = os.WriteFile(filepath.Join(root, "config.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	return fixture{t, s, root}
}
func (f fixture) call(operation string, args any, key string) response {
	f.t.Helper()
	raw, _ := json.Marshal(args)
	return handle(context.Background(), request{Store: f.root, User: "user-1", Operation: operation, Key: key, Args: raw})
}
func data(t *testing.T, r response) map[string]any {
	t.Helper()
	if r.Error != "" {
		t.Fatal(r.Error, r.Data)
	}
	b, _ := json.Marshal(r.Data)
	var v map[string]any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}
func (f fixture) memory(key, title, body, user string) string {
	f.t.Helper()
	r := data(f.t, f.call("save_memory", map[string]any{"title": title, "text": body, "user": user}, key))
	if r["status"] != "committed" {
		f.t.Fatal(r)
	}
	return r["id"].(string)
}
func TestSaveRetryAndPartialEditPreserveOriginalOwner(t *testing.T) {
	f := newFixture(t)
	id := f.memory("first", "A remembered day", "Exact words: α😀. Preserve these details.", "user-2")
	retry := data(t, f.call("save_memory", map[string]any{"title": "A remembered day", "text": "Exact words: α😀. Preserve these details.", "user": "user-2"}, "first"))
	if retry["id"] != id {
		t.Fatal("retry created another record", retry)
	}
	result := data(t, f.call("save_memory", map[string]any{"id": id, "title": "Corrected title"}, "correct"))
	if result["outcome"] != "updated" {
		t.Fatal("edit outcome was not reported", result)
	}
	doc, err := f.store.Read(id)
	if err != nil {
		t.Fatal(err)
	}
	record := doc.Record(songya.Memories)
	if record.User != "user-2" || doc.Body != "Exact words: α😀. Preserve these details." {
		t.Fatal("partial update changed owner/body", record)
	}
	conflict := f.call("save_memory", map[string]any{"title": "Changed intent", "text": "different", "user": "user-2"}, "first")
	if conflict.Error == "" {
		t.Fatal("same key accepted different intent")
	}
	unchanged := data(t, f.call("save_memory", map[string]any{"id": id, "title": "Corrected title"}, "unchanged"))
	if unchanged["outcome"] != "unchanged" {
		t.Fatal("no-op reported as a change", unchanged)
	}
}
func TestSourcePagesPreserveUTF8AndEveryWord(t *testing.T) {
	f := newFixture(t)
	body := strings.Repeat("δοκιμή 😀 quoted words\n", 2000)
	id := f.memory("long", "Long narrative", body, "user-1")
	var got strings.Builder
	offset := 0
	for i := 0; i < 1000; i++ {
		result := data(t, f.call("read_memory", map[string]any{"id": id, "view": "source", "offset": offset, "limit": 113}, ""))
		piece := result["text"].(string)
		if !utf8.ValidString(piece) {
			t.Fatal("split UTF8")
		}
		got.WriteString(piece)
		next := int(result["next"].(float64))
		if next == 0 {
			break
		}
		if next <= offset {
			t.Fatal("page failed to advance")
		}
		offset = next
	}
	doc, err := f.store.Read(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.String() != string(doc.OriginalSource()) || !strings.Contains(got.String(), body) {
		t.Fatal("source page lost or rewrote source")
	}
}
func TestScopedSearchAndConnectedStories(t *testing.T) {
	f := newFixture(t)
	entity := data(t, f.call("save_entity", map[string]any{"create": true, "name": "Example musician", "description": "A musician."}, "entity"))["id"].(string)
	id := f.memory("memory", "Example musician concert", "We heard Example musician playing piano.", "user-1")
	f.memory("other", "Example musician private", "Other owner's private concert account.", "user-2")
	data(t, f.call("save_memory", map[string]any{"id": id, "relations": []any{map[string]any{"type": "related_to", "target": entity}}}, "link"))
	story := data(t, f.call("save_story", map[string]any{"user": "user-1", "title": "Concert story", "text": "The concert", "relations": []any{map[string]any{"type": "related_to", "target": id}}}, "story"))["id"].(string)
	search := data(t, f.call("search_memory", map[string]any{"user": "user-1", "text": "Example musician", "mode": "lexical", "limit": 20}, ""))
	encoded, _ := json.Marshal(search)
	if bytes.Contains(encoded, []byte("Other owner's")) {
		t.Fatal("search escaped owner", search)
	}
	recall := data(t, f.call("recall_memory", map[string]any{"user": "user-1", "text": entity, "limit": 16384}, ""))
	encoded, _ = json.Marshal(recall)
	if !bytes.Contains(encoded, []byte(id)) || bytes.Contains(encoded, []byte("Other owner's")) {
		t.Fatal("connected recall scope lost", recall)
	}
	composed := data(t, f.call("compose_story", map[string]any{"id": story}, ""))
	encoded, _ = json.Marshal(composed)
	if !bytes.Contains(encoded, []byte("We heard Example musician")) {
		t.Fatal("story omitted connected narrative", composed)
	}
	graph := data(t, f.call("explore_memory", map[string]any{"user": "user-1", "id": entity, "direction": "both", "depth": 2, "limit": 20}, ""))
	encoded, _ = json.Marshal(graph)
	if !bytes.Contains(encoded, []byte(id)) {
		t.Fatal("graph lost connection", graph)
	}
}
func TestClassificationUsesSelectedUserAndKeepsOtherTypes(t *testing.T) {
	f := newFixture(t)
	cfg, err := f.store.TypeConfiguration(context.Background(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	cfg.Kinds[songya.Memories] = []songya.TypeDefinition{{ID: "fact", Name: "Fact", Description: "A remembered fact"}}
	if _, err := f.store.SaveTypeConfiguration(context.Background(), cfg, cfg.Version, nil, "type-fixture"); err != nil {
		t.Fatal(err)
	}
	typ := cfg.Kinds[songya.Memories][0].ID
	id := f.memory("owned", "Owner distinct from classifier", "A fact.", "user-2")
	data(t, f.call("save_memory", map[string]any{"id": id, "type": typ}, "classify"))
	doc, err := f.store.Read(id)
	if err != nil {
		t.Fatal(err)
	}
	if doc.TypeFor("user-1") != typ || doc.Record(songya.Memories).User != "user-2" {
		t.Fatal("classification changed ownership", doc)
	}
	result := data(t, f.call("type_configuration", map[string]any{}, ""))
	if result["user"] != "user-1" || result["instructions"] == "" {
		t.Fatal("classification guidance missing", result)
	}
}
func TestAttachmentsRevisionAndActualImageContent(t *testing.T) {
	f := newFixture(t)
	id := f.memory("with-image", "Picture memory", "Picture attached separately.", "user-1")
	path := filepath.Join(t.TempDir(), "image.png")
	var picture bytes.Buffer
	if err := png.Encode(&picture, stdimage.NewRGBA(stdimage.Rect(0, 0, 8, 8))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, picture.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	upload := data(t, f.call("upload_file", map[string]any{"path": path}, "upload"))
	list := data(t, f.call("list_files", map[string]any{"id": id}, ""))
	args := map[string]any{"id": id, "revision": list["revision"], "upload": upload["upload"], "filename": "image.png"}
	attached := data(t, f.call("attach_file", args, "attach"))
	if attached["status"] != "committed" {
		t.Fatal(attached)
	}
	again := data(t, f.call("attach_file", args, "attach"))
	if again["filename"] != attached["filename"] {
		t.Fatal("attachment retry duplicated filename", again)
	}
	viewed := f.call("read_file", map[string]any{"id": id, "filename": "image.png"}, "")
	if viewed.Error != "" || len(viewed.Images) != 1 || viewed.Images[0].MimeType != "image/png" {
		t.Fatal("image wasn't returned as pixels", viewed.Error, viewed.Data)
	}
	stale := f.call("remove_file", map[string]any{"id": id, "revision": list["revision"], "filename": "image.png"}, "stale")
	if stale.Error == "" {
		t.Fatal("stale attachment revision accepted")
	}
	current := data(t, f.call("list_files", map[string]any{"id": id}, ""))
	removed := data(t, f.call("remove_file", map[string]any{"id": id, "revision": current["revision"], "filename": "image.png"}, "remove"))
	if removed["status"] != "committed" {
		t.Fatal(removed)
	}
	if _, err := f.store.Read(id); err != nil {
		t.Fatal("removing a file removed record", err)
	}
}
func TestAutomaticRecallUsesControlledProviderAndKnownRecords(t *testing.T) {
	f := newFixture(t)
	id := f.memory("recall-me", "Train journey", "We travelled by train.", "user-1")
	hidden := f.memory("other-owner", "Private journey", "A different person's journey.", "user-2")
	r := data(t, f.call("automatic_recall", map[string]any{"messages": []string{"Tell me about the train"}, "owners": []string{"user-1", "agent"}, "known_ids": []string{id}}, ""))
	encoded, _ := json.Marshal(r)
	if !bytes.Contains(encoded, []byte(id)) || bytes.Contains(encoded, []byte(hidden)) {
		t.Fatal("recall scope wrong", r)
	}
	if !bytes.Contains(encoded, []byte(`"status":"current"`)) {
		t.Fatal("known record not refreshed", r)
	}
}
func TestMissingStoreAndUnsafeImportDoNotCreateSources(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing")
	reply := handle(context.Background(), request{Store: path, User: "user-1", Operation: "read_memory", Args: json.RawMessage(`{}`)})
	if reply.Error == "" {
		t.Fatal("missing store reported success")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("missing store created")
	}
	f := newFixture(t)
	if f.call("import_memories", map[string]any{"action": "apply", "root": "unconfigured", "path": "file.md"}, "import").Error == "" {
		t.Fatal("unconfigured import root accepted")
	}
	invalid := data(t, f.call("memory_maintenance", map[string]any{"action": "recover"}, ""))
	if _, ok := invalid["diagnostics"]; !ok {
		t.Fatal(invalid)
	}
	original := f.call("save_memory", map[string]any{"user": "user-1", "title": "Unsafe metadata", "text": "words", "metadata": map[string]any{"original_accounts": []any{"replacement"}}}, "original")
	if original.Error == "" {
		t.Fatal("generated fields modified original accounts")
	}
}
func TestCancelledRequestDoesNotReportSuccess(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	raw := json.RawMessage(`{"title":"Cancelled","text":"Do not claim success","user":"user-1"}`)
	reply := handle(ctx, request{Store: f.root, User: "user-1", Operation: "save_memory", Key: "cancelled", Args: raw})
	if reply.Error == "" {
		t.Fatal("cancelled request reported success", reply)
	}
}

func TestTinyPagesAdvanceAcrossMultibyteCharacters(t *testing.T) {
	original := []byte("α😀終")
	offset := 0
	var got strings.Builder
	for i := 0; i < 10; i++ {
		p := page(original, offset, 1)
		got.WriteString(p["text"].(string))
		next := p["next"].(int)
		if next == 0 {
			break
		}
		if next <= offset {
			t.Fatal("page failed to advance", p)
		}
		offset = next
	}
	if got.String() != string(original) {
		t.Fatal("tiny pages lost text", got.String())
	}
}
