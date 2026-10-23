package sidecar

import (
	"container/list"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/engine"
)

// Limits on the files one run imports. A compile cannot be interrupted, so
// the size of a file bounds how long its compile can delay a cancel, and the
// compiled code is the sidecar's memory, outside the run's budget.
const (
	maxModuleBytes    = 1 << 20
	maxRunModuleBytes = 8 << 20
	maxRunModules     = 256
	// moduleCacheBytes bounds the source size of the compiled files the
	// sidecar keeps for later runs.
	moduleCacheBytes = 64 << 20
)

//go:embed node/*.js
var nodeSources embed.FS

// builtins are the node: modules, by the names a program imports them by.
// Each compiles once per process.
var builtins = map[string]*builtin{
	"path":            {file: "path.js"},
	"path/posix":      {file: "path_posix.js"},
	"path/win32":      {file: "path_win32.js"},
	"util":            {file: "util.js"},
	"timers":          {file: "timers.js"},
	"timers/promises": {file: "timers_promises.js"},
	"vm":              {file: "vm.js"},
}

// builtinNames lists the built-in modules for error messages.
const builtinNames = "node:path, node:util, node:timers, node:timers/promises and node:vm"

type builtin struct {
	file string
	once sync.Once
	mod  *moejs.Module
	err  error
}

// module returns the builtin's module, compiled on first use.
func (b *builtin) module(name string) (*moejs.Module, error) {
	b.once.Do(func() {
		var src []byte
		if src, b.err = nodeSources.ReadFile("node/" + b.file); b.err == nil {
			b.mod, b.err = moejs.Compile("node:"+name, string(src))
		}
	})
	return b.mod, b.err
}

// isBuiltin reports whether m is a node: module.
func isBuiltin(m *moejs.Module) bool { return strings.HasPrefix(m.Name(), "node:") }

// moduleCache keeps the files the sidecar compiled for later runs, by path
// and content, so that a file compiles once for each content it has. The
// least recently used go first once the sources pass moduleCacheBytes.
type moduleCache struct {
	mu      sync.Mutex
	entries map[moduleKey]*list.Element
	order   list.List // of *cachedModule, most recent first
	bytes   int
}

type moduleKey struct {
	path string
	sum  [sha256.Size]byte
}

type cachedModule struct {
	key  moduleKey
	mod  *moejs.Module
	size int
}

func (c *moduleCache) get(key moduleKey) *moejs.Module {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.entries[key]
	if e == nil {
		return nil
	}
	c.order.MoveToFront(e)
	return e.Value.(*cachedModule).mod
}

// put keeps mod and returns the module to use for key: mod, or the one a
// concurrent run compiled first.
func (c *moduleCache) put(key moduleKey, mod *moejs.Module, size int) *moejs.Module {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e := c.entries[key]; e != nil {
		c.order.MoveToFront(e)
		return e.Value.(*cachedModule).mod
	}
	if size > moduleCacheBytes {
		return mod
	}
	if c.entries == nil {
		c.entries = map[moduleKey]*list.Element{}
	}
	c.entries[key] = c.order.PushFront(&cachedModule{key: key, mod: mod, size: size})
	c.bytes += size
	for c.bytes > moduleCacheBytes {
		last := c.order.Back()
		old := c.order.Remove(last).(*cachedModule)
		delete(c.entries, old.key)
		c.bytes -= old.size
	}
	return mod
}

// imports resolves what one run imports: the built-in node: modules, data:
// URLs of JavaScript, and the .ts, .mts, .js and .mjs files under the run's
// module root. The run's goroutine owns it.
type imports struct {
	cache *moduleCache
	// cwd is the run's working directory in dsh's execution world, which
	// node:path resolves against.
	cwd string
	// root is cwd on this host, empty when the run may not import files.
	root    string
	dir     *os.Root // root, opened on first use
	dirErr  error
	files   map[string]*moejs.Module // imported so far, by path
	bytes   int
	runtime func() *runtimeValues
}

// runtimeValues are what the built-in modules receive through import.meta:
// the function that returns the runtime's inspect, which the console uses,
// and the timer functions of the run's runtime.
type runtimeValues struct {
	inspector moejs.Value
	timers    map[string]moejs.Value
}

func newImports(cache *moduleCache, cwd, root string, values func() *runtimeValues) *imports {
	return &imports{cache: cache, cwd: cwd, root: root, files: map[string]*moejs.Module{}, runtime: values}
}

func (im *imports) importer() *moejs.Importer {
	return &moejs.Importer{Resolve: im.resolve, Meta: im.meta}
}

// close releases the module root.
func (im *imports) close() {
	if im.dir != nil {
		_ = im.dir.Close()
	}
}

func (im *imports) resolve(referrer moejs.Referrer, specifier string) (*moejs.Module, error) {
	name, prefixed := strings.CutPrefix(specifier, "node:")
	if b := builtins[name]; b != nil {
		return b.module(name)
	}
	switch {
	case prefixed:
		return nil, fmt.Errorf("Cannot import %q: this runtime has no %s; the program reaches files, commands and the network through its tools, and the built-in modules are %s", specifier, specifier, builtinNames)
	case strings.HasPrefix(specifier, "data:"):
		return im.data(specifier)
	case isFileSpecifier(specifier):
		return im.file(referrer, specifier)
	}
	return nil, fmt.Errorf("Cannot import %q: packages are not available; import a file of the working directory by its path, such as \"./helpers.ts\", or one of %s", specifier, builtinNames)
}

// isFileSpecifier reports whether specifier names a file: a relative or
// absolute path, or a file: URL.
func isFileSpecifier(specifier string) bool {
	return specifier == "." || specifier == ".." || strings.HasPrefix(specifier, "./") || strings.HasPrefix(specifier, "../") ||
		strings.HasPrefix(specifier, "/") || strings.HasPrefix(specifier, "file:") || filepath.IsAbs(specifier) ||
		(runtime.GOOS == "windows" && (strings.HasPrefix(specifier, ".\\") || strings.HasPrefix(specifier, "..\\")))
}

// file imports a file under the module root. A relative path resolves
// against the importing module's directory, and against the working
// directory in the program.
func (im *imports) file(referrer moejs.Referrer, specifier string) (*moejs.Module, error) {
	fail := func(format string, args ...any) error {
		return fmt.Errorf("Cannot import %q: %s", specifier, fmt.Sprintf(format, args...))
	}
	base := ""
	if referrer != nil {
		switch from := referrer.Name(); {
		case strings.HasPrefix(from, "node:"), strings.HasPrefix(from, "data:"):
			return nil, fail("a module of %s cannot import files", strings.SplitN(from, ",", 2)[0])
		case filepath.IsAbs(from):
			base = filepath.Dir(from)
		}
	}
	if im.root == "" {
		return nil, fail("this run cannot import files, because its working directory is on another host than the moejs sidecar")
	}
	if base == "" {
		base = im.root
	}
	var target string
	switch {
	case strings.HasPrefix(specifier, "file:"):
		path, err := fileURLPath(specifier)
		if err != nil {
			return nil, fail("%v", err)
		}
		target = path
	case filepath.IsAbs(specifier):
		target = specifier
	default:
		target = filepath.Join(base, specifier)
	}
	target = filepath.Clean(target)
	rel, err := filepath.Rel(im.root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return nil, fail("%s is outside the working directory %s", target, im.root)
	}
	var compile func(name, source string) (*moejs.Module, error)
	switch filepath.Ext(target) {
	case ".ts", ".mts":
		compile = moejs.CompileTS
	case ".js", ".mjs":
		compile = moejs.Compile
	case ".json":
		return nil, fail("JSON modules are not supported; read the file with a tool and parse it with JSON.parse")
	default:
		return nil, fail("only .ts, .mts, .js and .mjs files can be imported, with their extension in the specifier")
	}
	if m := im.files[target]; m != nil {
		return m, nil
	}
	if len(im.files) >= maxRunModules {
		return nil, fail("a run may import at most %d files", maxRunModules)
	}
	src, err := im.read(rel)
	if err != nil {
		return nil, fail("%s %v%s", target, err, im.sibling(rel, err))
	}
	if im.bytes += len(src); im.bytes > maxRunModuleBytes {
		return nil, fail("the files a run imports may hold at most %d bytes", maxRunModuleBytes)
	}
	key := moduleKey{path: target, sum: sha256.Sum256(src)}
	m := im.cache.get(key)
	if m == nil {
		// Node drops a byte order mark too.
		if m, err = compile(target, strings.TrimPrefix(string(src), "\uFEFF")); err != nil {
			var se *moejs.SyntaxError
			if errors.As(err, &se) {
				se.Message = syntaxHint(se.Message)
			}
			return nil, err
		}
		m = im.cache.put(key, m, len(src))
	}
	im.files[target] = m
	return m, nil
}

// sibling names the TypeScript file beside a missing .js or .mjs file:
// TypeScript's own imports name the .js file that tsc would emit, and this
// runtime runs the .ts file itself.
func (im *imports) sibling(rel string, err error) string {
	if !errors.Is(err, errNotExist) || im.dir == nil {
		return ""
	}
	var ts string
	switch filepath.Ext(rel) {
	case ".js":
		ts = strings.TrimSuffix(rel, ".js") + ".ts"
	case ".mjs":
		ts = strings.TrimSuffix(rel, ".mjs") + ".mts"
	default:
		return ""
	}
	if info, err := im.dir.Stat(ts); err == nil && info.Mode().IsRegular() {
		return "; import \"./" + filepath.ToSlash(filepath.Base(ts)) + "\" by its own name"
	}
	return ""
}

// errNotExist is read's error for a missing file.
var errNotExist = errors.New("does not exist")

// read returns the content of the regular file rel under the module root.
func (im *imports) read(rel string) ([]byte, error) {
	if im.dir == nil && im.dirErr == nil {
		im.dir, im.dirErr = os.OpenRoot(im.root)
	}
	if im.dirErr != nil {
		return nil, fmt.Errorf("cannot be read: the working directory does not open: %w", im.dirErr)
	}
	// A FIFO would block the open without the nonblocking flag.
	f, err := im.dir.OpenFile(rel, os.O_RDONLY|openNonblock, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, errNotExist
	}
	if err != nil {
		return nil, fmt.Errorf("cannot be read: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("cannot be read: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("is not a regular file")
	}
	src, err := io.ReadAll(io.LimitReader(f, maxModuleBytes+1))
	if err != nil {
		return nil, fmt.Errorf("cannot be read: %w", err)
	}
	if len(src) > maxModuleBytes {
		return nil, fmt.Errorf("is larger than %d bytes, the most one imported file may hold", maxModuleBytes)
	}
	return src, nil
}

// fileURLPath returns the path of a file: URL on this host.
func fileURLPath(specifier string) (string, error) {
	u, err := url.Parse(specifier)
	if err != nil {
		return "", err
	}
	if u.Host != "" && u.Host != "localhost" {
		return "", errors.New("a file: URL must name a file on this host")
	}
	path := u.Path
	if runtime.GOOS == "windows" {
		// file:///C:/dir/file.ts
		path = strings.TrimPrefix(path, "/")
	}
	path = filepath.FromSlash(path)
	if !filepath.IsAbs(path) {
		return "", errors.New("a file: URL must hold an absolute path")
	}
	return path, nil
}

// data imports a data: URL of JavaScript, which may import the built-in
// modules and other data: URLs.
func (im *imports) data(specifier string) (*moejs.Module, error) {
	header, payload, ok := strings.Cut(strings.TrimPrefix(specifier, "data:"), ",")
	mediaType, encoding, _ := strings.Cut(header, ";")
	if !ok || (mediaType != "text/javascript" && mediaType != "application/javascript") || (encoding != "" && encoding != "base64") {
		return nil, fmt.Errorf("Cannot import %.64q: only data: URLs of text/javascript can be imported", specifier)
	}
	var src []byte
	var err error
	if encoding == "base64" {
		src, err = decodeBase64(payload)
	} else {
		var text string
		text, err = url.PathUnescape(payload)
		src = []byte(text)
	}
	if err != nil {
		return nil, fmt.Errorf("Cannot import %.64q: %v", specifier, err)
	}
	if len(src) > maxModuleBytes {
		return nil, fmt.Errorf("Cannot import %.64q: the module is larger than %d bytes", specifier, maxModuleBytes)
	}
	key := moduleKey{path: "data:", sum: sha256.Sum256(src)}
	id := fmt.Sprintf("data:%x", key.sum)
	if m := im.files[id]; m != nil {
		return m, nil
	}
	if len(im.files) >= maxRunModules {
		return nil, fmt.Errorf("Cannot import %.64q: a run may import at most %d modules", specifier, maxRunModules)
	}
	if im.bytes += len(src); im.bytes > maxRunModuleBytes {
		return nil, fmt.Errorf("Cannot import %.64q: the modules a run imports may hold at most %d bytes", specifier, maxRunModuleBytes)
	}
	m := im.cache.get(key)
	if m == nil {
		name := fmt.Sprintf("data:text/javascript,%x", key.sum[:6])
		if m, err = moejs.Compile(name, string(src)); err != nil {
			return nil, err
		}
		m = im.cache.put(key, m, len(src))
	}
	im.files[id] = m
	return m, nil
}

// decodeBase64 decodes the payload of a base64 data: URL, which may also be
// percent-encoded.
func decodeBase64(payload string) ([]byte, error) {
	text, err := url.PathUnescape(payload)
	if err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(text)
}

// meta fills import.meta: url, filename and dirname for a file, as Node
// does, and for a built-in module the values of the run it needs.
func (im *imports) meta(r *moejs.Realm, m *moejs.Module, meta *moejs.Object) error {
	set := func(key string, v moejs.Value) {
		_, _ = meta.CreateDataProperty(r, r.KeyFromGoString(key), v)
	}
	name := m.Name()
	switch {
	case isBuiltin(m):
		values := im.runtime()
		set("cwd", moejs.String(im.cwd))
		set("platform", moejs.String(nodePlatform()))
		set("inspector", values.inspector)
		timers := r.NewObject()
		for key, fn := range values.timers {
			_, _ = timers.CreateDataProperty(r, r.KeyFromGoString(key), fn)
		}
		set("timers", engine.ObjectValue(timers))
	case filepath.IsAbs(name):
		u := url.URL{Scheme: "file", Path: filepath.ToSlash(name)}
		if runtime.GOOS == "windows" {
			u.Path = "/" + u.Path
		}
		set("url", moejs.String(u.String()))
		set("filename", moejs.String(name))
		set("dirname", moejs.String(filepath.Dir(name)))
	}
	return nil
}

// nodePlatform is process.platform for this host.
func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}
