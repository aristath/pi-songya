// songya-tools calls the existing Songya library directly. One JSON request and
// response per process; no MCP server, model loop, or the agent runtime is involved.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf8"

	"github.com/aristath/songya"
)

type request struct {
	Store     string            `json:"store"`
	Config    string            `json:"config"`
	User      string            `json:"user"`
	Operation string            `json:"operation"`
	Key       string            `json:"key"`
	Roots     map[string]string `json:"roots"`
	Args      json.RawMessage   `json:"args"`
}
type response struct {
	Data   any     `json:"data,omitempty"`
	Error  string  `json:"error,omitempty"`
	Images []image `json:"images,omitempty"`
}
type image struct {
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var q request
	reply := response{}
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 64<<20)).Decode(&q); err != nil {
		reply.Error = err.Error()
	} else {
		reply = handle(ctx, q)
	}
	if err := json.NewEncoder(os.Stdout).Encode(reply); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func handle(ctx context.Context, q request) response {
	if q.Store == "" || q.User == "" || q.User == "all" {
		return response{Error: "Configure a Songya store path and name in Pi settings"}
	}
	// Provisioning is an application operation, not a model tool. Reads below
	// continue to reject a missing existing store rather than replacing it.
	if q.Operation == "initialize_store" {
		if _, err := songya.Open(q.Store); err != nil {
			return response{Error: err.Error()}
		}
		return response{Data: map[string]any{"initialized": true}}
	}
	store, err := songya.OpenExisting(q.Store)
	if err != nil {
		return response{Error: err.Error()}
	}
	// Reads must not create a missing source. Writers use Songya's normal
	// initialization/recovery once OpenExisting has established that it exists.
	if strings.HasPrefix(q.Operation, "save_") || q.Operation == "organize_memory" || q.Operation == "upload_file" || q.Operation == "attach_file" || q.Operation == "replace_file" || q.Operation == "remove_file" || q.Operation == "import_memories" || q.Operation == "memory_maintenance" {
		store, err = songya.Open(q.Store)
		if err != nil {
			return response{Error: err.Error()}
		}
	}
	if q.Config == "" {
		q.Config = filepath.Join(q.Store, "config.json")
	}
	store.UseConfiguration(q.Config)
	if q.Operation != "read_memory" && strings.HasPrefix(q.Operation, "save_") && strings.Contains(string(q.Args), `"original_accounts"`) {
		return response{Data: map[string]any{"status": "not_accepted"}, Error: "Original accounts cannot be edited through generated record fields."}
	}
	data, images, err := dispatch(ctx, store, q)
	reply := response{Data: data, Images: images}
	if err != nil {
		reply.Error = err.Error()
	}
	return reply
}
func decode[T any](raw json.RawMessage) (T, error) {
	var v T
	err := json.Unmarshal(raw, &v)
	return v, err
}
func kind(id string) songya.Destination {
	for prefix, k := range map[string]songya.Destination{"m_": songya.Memories, "e_": songya.Entities, "t_": songya.Topics, "s_": songya.Stories} {
		if strings.HasPrefix(id, prefix) {
			return k
		}
	}
	return ""
}
func defaultSize(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}
func page(data []byte, offset, limit int) map[string]any {
	start := min(max(0, offset), len(data))
	if limit <= 0 {
		limit = 16384
	}
	limit = min(limit, 65536)
	for start < len(data) && !utf8.RuneStart(data[start]) {
		start++
	}
	end := min(start+limit, len(data))
	for end > start && end < len(data) && !utf8.RuneStart(data[end]) {
		end--
	}
	if end == start && start < len(data) {
		_, size := utf8.DecodeRune(data[start:])
		end = start + size
	}
	next := 0
	if end < len(data) {
		next = end
	}
	return map[string]any{"text": string(data[start:end]), "offset": start, "next": next, "truncated": next != 0}
}
func saved(ctx context.Context, s *songya.Store, r songya.Receipt, ref string) map[string]any {
	out := map[string]any{"status": r.Status, "operation_id": r.Key, "diagnostics": r.Diagnostics, "records": r.Records, "ids": r.Refs}
	id := r.Refs[ref]
	out["id"] = id
	for _, v := range r.Records {
		if v.ID == id {
			out["outcome"], out["changed_fields"] = v.Outcome, v.ChangedFields
		}
	}
	if id != "" {
		if bytes, err := s.BatchData(ctx, r.Key, id, "proposed"); err == nil {
			doc := songya.Parse(bytes)
			doc.ID = id
			record := doc.Record(kind(id))
			out["record"] = record
		}
	}
	return out
}
func dispatch(ctx context.Context, s *songya.Store, q request) (any, []image, error) {
	raw := q.Args
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	var args map[string]json.RawMessage
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil, nil, err
	}
	text := func(key string) string { var v string; _ = json.Unmarshal(args[key], &v); return v }
	number := func(key string) int { var v int; _ = json.Unmarshal(args[key], &v); return v }
	switch q.Operation {
	case "type_configuration":
		cfg, err := s.TypeConfiguration(ctx)
		return map[string]any{"my_entity": cfg.MyEntity, "kinds": cfg.Kinds, "version": cfg.Version, "diagnostics": cfg.Diagnostics, "instructions": songya.TypeInstructions(cfg)}, nil, err
	case "prepare_memory":
		result, err := s.Prepare(ctx, text("text"), defaultSize(number("limit"), 8))
		return result, nil, err
	case "search_memory":
		in, err := decode[songya.Query](raw)
		if err != nil {
			return nil, nil, err
		}
		result, err := s.Search(ctx, in)
		return result, nil, err
	case "recall_memory":
		in, err := decode[songya.RecallQuery](raw)
		if err != nil {
			return nil, nil, err
		}
		result, err := s.Recall(ctx, in)
		return result, nil, err
	case "explore_memory":
		in, err := decode[songya.GraphQuery](raw)
		if err != nil {
			return nil, nil, err
		}
		result, err := s.Graph(ctx, in)
		return result, nil, err
	case "memory_timeline":
		in, err := decode[songya.Query](raw)
		if err != nil {
			return nil, nil, err
		}
		result, err := s.Timeline(ctx, in)
		return result, nil, err
	case "compose_story":
		result, err := s.Compose(ctx, text("id"), number("offset"), defaultSize(number("limit"), 8192))
		return result, nil, err
	case "automatic_recall":
		in, err := decode[songya.RecallRequest](raw)
		if err != nil {
			return nil, nil, err
		}
		if err = in.Validate(); err != nil {
			return nil, nil, err
		}
		result, err := s.Retrieve(ctx, in)
		return result, nil, err
	case "read_memory":
		var bytes []byte
		var err error
		id := text("id")
		view := text("view")
		switch {
		case text("key") != "":
			bytes, err = s.BatchData(ctx, text("key"), id, view)
		case text("archive") != "":
			bytes, err = s.ReadArchive(text("archive"))
		case text("root") != "":
			root, ok := q.Roots[text("root")]
			if !ok {
				return nil, nil, fmt.Errorf("import root %q is not configured", text("root"))
			}
			bytes, _, err = s.ImportSource(root, text("source"))
		case text("source") != "":
			bytes, err = s.ReadSource(text("source"))
		default:
			var doc *songya.Document
			doc, err = s.Read(id)
			if err == nil {
				if view == "source" {
					bytes = doc.OriginalSource()
					if bytes == nil {
						bytes, err = doc.Marshal()
					}
				} else {
					bytes = []byte(doc.Body)
				}
			}
		}
		if err != nil {
			return nil, nil, err
		}
		out := page(bytes, number("offset"), number("limit"))
		out["id"], out["view"] = id, view
		return out, nil, nil
	case "save_memory":
		in, err := decode[songya.MemoryInput](raw)
		if err != nil {
			return nil, nil, err
		}
		if in.ID == "" && (in.Text == nil || strings.TrimSpace(*in.Text) == "") && strings.TrimSpace(in.Append) == "" {
			return map[string]any{"status": "not_accepted"}, nil, errors.New("new memories need text")
		}
		in.Key = q.Key
		r, err := s.SaveMemory(ctx, in)
		return saved(ctx, s, r, "memory"), nil, err
	case "save_entity", "save_topic":
		in, err := decode[songya.NamedInput](raw)
		if err != nil {
			return nil, nil, err
		}
		in.Key = q.Key
		k := songya.Entities
		if q.Operation == "save_topic" {
			k = songya.Topics
		}
		r, err := s.SaveNamed(ctx, k, in)
		return saved(ctx, s, r, "record"), nil, err
	case "save_story":
		in, err := decode[songya.StoryInput](raw)
		if err != nil {
			return nil, nil, err
		}
		in.Key = q.Key
		r, err := s.SaveStory(ctx, in)
		return saved(ctx, s, r, "story"), nil, err
	case "list_files":
		listing, err := s.Attachments(ctx, text("id"))
		if err != nil {
			return nil, nil, err
		}
		start := min(max(0, number("offset")), len(listing.Files))
		limit := number("limit")
		if limit <= 0 {
			limit = 16
		}
		end := min(start+limit, len(listing.Files))
		next := 0
		if end < len(listing.Files) {
			next = end
		}
		return map[string]any{"files": listing.Files[start:end], "revision": listing.Revision, "pending": listing.Pending, "diagnostics": listing.Diagnostics, "next": next}, nil, nil
	case "read_file":
		id, name := text("id"), text("filename")
		file, attachment, err := s.OpenAttachment(ctx, id, name)
		if err != nil {
			return nil, nil, err
		}
		defer file.Close()
		if attachment.Preview == "image" {
			bytes, mime, err := songya.AttachmentImage(ctx, file, 1600)
			if err != nil {
				return nil, nil, err
			}
			metadata := map[string]any{"file": attachment}
			if attachment.MediaType == "image/gif" {
				metadata["note"] = "First frame only; the full animation was not inspected."
			}
			return metadata, []image{{Data: base64.StdEncoding.EncodeToString(bytes), MimeType: mime}}, nil
		}
		if attachment.Preview == "text" {
			body, next, err := s.ReadAttachmentText(ctx, id, name, int64(number("offset")), 16384)
			return map[string]any{"text": body, "next": next, "file": attachment}, nil, err
		}
		return map[string]any{"file": attachment, "note": "Original binary attachment; its contents have not been interpreted."}, nil, nil
	case "upload_file":
		file, err := os.Open(text("path"))
		if err != nil {
			return nil, nil, err
		}
		defer file.Close()
		name := text("filename")
		if name == "" {
			name = filepath.Base(text("path"))
		}
		result, err := s.Upload(ctx, q.Key, q.User, name, file)
		return result, nil, err
	case "attach_file", "replace_file", "remove_file":
		in, err := decode[songya.FileChange](raw)
		if err != nil {
			return nil, nil, err
		}
		in.Key = q.Key
		in.Action = map[string]string{"attach_file": "add", "replace_file": "replace", "remove_file": "remove"}[q.Operation]
		result, err := s.ChangeFile(ctx, in)
		return result, nil, err
	case "file_status":
		result, err := s.FileChangeReceipt(ctx, text("key"))
		return result, nil, err
	case "organize_memory":
		var in struct {
			Action   string
			Sources  []string
			Source   string
			Kind     songya.Destination
			Metadata map[string]any
			Text     *string
			Parts    []struct {
				Kind     songya.Destination
				Metadata map[string]any
				Text     string
			}
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, nil, err
		}
		switch in.Action {
		case "merge":
			sources := []songya.Version{}
			for _, id := range in.Sources {
				sources = append(sources, songya.Version{ID: id})
			}
			r, err := s.Merge(ctx, songya.MergeRequest{Key: q.Key, Sources: sources, Kind: in.Kind, Fields: in.Metadata, Body: in.Text})
			return saved(ctx, s, r, "merged"), nil, err
		case "split":
			parts := []songya.Part{}
			for _, p := range in.Parts {
				parts = append(parts, songya.Part{Kind: p.Kind, Fields: p.Metadata, Body: p.Text})
			}
			r, err := s.Split(ctx, songya.SplitRequest{Key: q.Key, Source: songya.Version{ID: in.Source}, Parts: parts})
			return saved(ctx, s, r, ""), nil, err
		default:
			return nil, nil, errors.New("choose merge or split")
		}
	case "import_memories":
		var in struct {
			Action, Root, Path string
			Parts              []struct {
				Start, End *int
				Kind       songya.Destination
				Metadata   map[string]any
			}
			Offset, Limit int
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, nil, err
		}
		root, ok := q.Roots[in.Root]
		if !ok {
			return nil, nil, fmt.Errorf("import root %q is not configured", in.Root)
		}
		if in.Action == "preview" {
			r, err := s.PreviewImports(ctx, root, in.Offset, in.Limit)
			return r, nil, err
		}
		if in.Action != "apply" {
			return nil, nil, errors.New("choose preview or apply")
		}
		parts := []songya.ImportPart{}
		for _, p := range in.Parts {
			if p.Start == nil || p.End == nil {
				return nil, nil, errors.New("each import part needs start and end byte offsets")
			}
			parts = append(parts, songya.ImportPart{Start: *p.Start, End: *p.End, Kind: p.Kind, Fields: p.Metadata})
		}
		r, err := s.Import(ctx, root, songya.ImportRequest{Path: in.Path, Parts: parts})
		return r, nil, err
	case "memory_maintenance":
		switch text("action") {
		case "status":
			return map[string]any{"diagnostics": s.Diagnostics(), "import_roots": q.Roots}, nil, nil
		case "receipt":
			r, err := s.BatchStatus(ctx, text("key"))
			return r, nil, err
		case "recover":
			err := s.Recover()
			return map[string]any{"diagnostics": s.Diagnostics()}, nil, err
		case "rebuild":
			r, err := s.Rebuild(ctx)
			return map[string]any{"records": len(r.Records), "diagnostics": r.Diagnostics}, nil, err
		case "embed":
			r, err := s.IndexEmbeddings(ctx)
			return r, nil, err
		case "abandon":
			r, err := s.AbandonBatch(ctx, text("key"))
			return r, nil, err
		default:
			return nil, nil, errors.New("choose status, receipt, recover, rebuild, embed or abandon")
		}
	default:
		return nil, nil, fmt.Errorf("unknown Songya operation %q", q.Operation)
	}
}
