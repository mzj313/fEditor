# fEditor · Lightweight Text Editor

**One window for writing, editing, and viewing. Lightness comes first.**

fEditor is a desktop text editor for writers and developers: Markdown, JSON, YAML, TOML and everyday text live in the same window, with JSON formatting and validation plus one-click YAML/TOML cleanup; Markdown previews as you write, and PDF, Word, images, audio and video can be read without leaving the app. It is light enough to disappear: a ten-megabyte single-file app, no installer, double-click to launch, tens of megabytes of resident memory, and one codebase for Windows and macOS.

## Highlights

| Area | Capability |
|---|---|
| Light footprint | No bundled browser engine, ~450 KB first screen, heavy assets loaded on demand, 30–60 MB idle memory, ten-megabyte single file |
| Write immediately | Window appears first, session restore runs asynchronously; tabs, active tab, cursor and scroll position come back; recent files one click away |
| Edit comfortably | Syntax highlighting for Markdown / JSON / YAML / TOML / SVG; JSON format and validate; comment-preserving YAML format; toggle preview with Mermaid diagrams, task lists and relative-path images |
| Change precisely | Find and replace across every text tab: case sensitive, whole word, regex, replace in selection, replace one or all; rectangular selection with multi-cursor editing |
| Save safely | Write back in the original encoding (UTF-8 / GBK / GB18030), preserve CRLF and BOM; same-directory temp file plus `sync_all` and atomic replace; external changes are caught before overwriting |
| View broadly | Lazy PDF page rendering, paginated DOCX layout, 1:1 image zoom, streaming audio and video; binary files are rejected explicitly |

## Project Facts

| Item | Detail |
|---|---|
| Target platforms | Windows 10/11, macOS |
| Form factor | Portable single executable (Windows `.exe`, macOS `.app` / `.dmg`) with launch scripts under `scripts/`; no installer |
| Stack | Tauri 2 + vanilla TypeScript + Vite + CodeMirror 6 |

## Goals and Non-Goals

| Goals | Non-goals |
|---|---|
| Restore previously opened files on launch | Plugin system, Git integration, LSP |
| Multiple tabs, edit, save, save as | Side-by-side live preview, minimap |
| Markdown highlighting with toggle preview | Video transcoding, subtitle tracks |
| Search and replace plus column selection for txt and other text files | Advanced regex features (capture-group references) |
| One codebase for Windows and macOS | Cloud sync, collaborative editing |
| Single-file distribution, no install | Full IDE capability (that is VS Code's territory) |

`others/dbx/dbx-file-viewer` is kept as a feature reference only; neither its code nor its plugin architecture was migrated.

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Desktop framework | Tauri 2 | Reuses the system WebView instead of embedding Chromium |
| Backend | Rust with a minimal feature set | File I/O, encoding conversion, native dialogs, session file |
| Frontend | Vanilla TypeScript + Vite, no Vue/React | Saves runtime and bundle size |
| Editor | CodeMirror 6 (state / view / commands / lang-markdown) | Line numbers, syntax highlighting, independent undo stack |
| Search and replace | `@codemirror/search` | `searchKeymap`, `openSearchPanel`, `replaceAll` |
| Column selection | `rectangularSelection` from `@codemirror/view` | Native rectangular selection and multi-cursor |
| Markdown preview | `markdown-it` + `DOMPurify` | Render only when preview opens; sanitize before output |
| Document preview | `pdfjs-dist`, `docx-preview`, custom media protocol | Read-only PDF / DOCX / image / audio / video |
| Diagrams | `mermaid` | Render diagrams inside Markdown |
| Terminal | `@xterm/xterm` + `addon-fit` | Built-in terminal panel |
| Encoding | `encoding_rs` + `chardetng` | Detect and write back UTF-8 / GBK / GB18030 |
| Atomic writes | `tempfile` | Same-directory temp file + `sync_all` + replace |
| Dialogs | `rfd` or `tauri-plugin-dialog` | Native open/save dialogs across platforms |
| Explicitly excluded | Electron, Monaco, Flutter, JavaFX, Wails | Size or memory constraints |

**Size and performance budget** (unlabeled figures are targets, not guarantees)

| Metric | Measured / target |
|---|---|
| Frontend first screen | ~450 KB measured (427 KB JS + 17 KB CSS) |
| On-demand frontend assets | ~8 MB measured (mermaid, pdf.js, xterm, docx-preview load only when used) |
| Installer / app size | Target 10–15 MB (frontend assets + Rust binary) |
| Idle memory | 30–60 MB |
| Cold start | Window visible first, session restored asynchronously |

Size optimizations: `strip = true`, `lto = true`, `codegen-units = 1`, `panic = "abort"`, `opt-level = "z"`; no frontend framework; search results panel and preview rendering are lazy-loaded out of the first screen. The build clears `dist` so stale hashed files never reach the bundle.

## Features

| Module | Capability |
|---|---|
| Tabs | New, open, switch by click, close with middle click, dirty marker `*`, close confirmation |
| Session | Restore tabs, active tab, cursor and scroll position on launch; recent files list |
| Editing | Markdown highlighting, line numbers, word-wrap toggle, independent undo stacks, find and replace, rectangular selection with multi-cursor |
| Search and replace | Works on every text tab, including txt: case sensitive, whole word, regex, replace in selection, find previous/next, replace one/all |
| Column mode | Works on every text tab, including txt: rectangular drag selection, split selection into per-line cursors, add cursor above/below, type or delete across cursors, `Esc` back to a single cursor |
| Files | Open, save, save as, drag and drop, path from CLI arguments |
| File types | See "Supported formats": text is editable; PDF / DOCX / images / audio / video are read-only previews; binary files are refused |
| Preview | Toggle preview for Markdown and SVG (sanitized HTML / graphics); preview mode is read-only |
| Binary preview | Lazy PDF pages, paginated DOCX, image zoom and 1:1 view, audio and video playback (speed, loop); PDF resources are released when switching away |
| Status bar | Line/column, character count, encoding, EOL, language mode, cursor count / column mode, save state |
| Encoding | Read and write back UTF-8 / GBK / GB18030, preserving BOM and CRLF |

### Supported formats

**Editable text** (up to 100 MB, non-binary)

| Type | Extensions | Capability |
|---|---|---|
| Markdown | `.md` `.markdown` | Highlighting, toggle preview, Mermaid, task lists, relative-path images |
| JSON | `.json` | Highlighting, format and validate (selection supported) |
| YAML | `.yaml` `.yml` | Highlighting, format preserving comments and key order |
| TOML | `.toml` | Highlighting, format (comments are lost, asks first) |
| SVG | `.svg` | Text editing plus graphic preview (opens in preview by default, rendered via `<img>`, scripts do not run) |
| Other text | No extension whitelist, e.g. `.txt` `.log` `.sql` `.xml` `.csv` `.ini` and common source extensions | Plain text editing without highlighting |

Encoding: UTF-8 / UTF-8 BOM / GBK / GB18030 are detected and written back unchanged. Files containing NUL in the first 8 KB are treated as binary and refused.

**Read-only preview**

| Format | Extensions | Capability | Limit |
|---|---|---|---|
| PDF | `.pdf` | pdf.js lazy per-page rendering, zoom 40%–300%, page number follows scroll, streamed via a custom protocol instead of base64 | 100 MB |
| Word | `.docx` | docx-preview paginated layout, headers and footers preserved | 100 MB |
| Images | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp` `.ico` | Fit to window, zoom buttons, 1:1 view, original pixel size | 40 MB |
| Audio | `.mp3` `.m4a` `.wav` `.aac` `.flac` | Streaming playback, 0.75–1.5× speed, loop | 100 MB fallback |
| Video | `.mp4` `.webm` | Streaming playback, 0.75–1.5× speed, loop; H.264 + AAC recommended for MP4 | 4 MB protocol chunks, 100 MB fallback |

**Markdown embeds**: Mermaid diagrams (flowchart, sequence, class, and more); local images `svg/png/jpg/jpeg/gif/webp/bmp/ico` resolved relative to the document directory, 50 MB each; `http(s)` / `data:` / `blob:` URLs are left untouched.

**Not supported**: legacy `.doc`, Excel and PowerPoint, archives, executables and other binary files are refused with a prompt; `ogg/opus/wma` are outside the audio whitelist; only MP4 / WebM video, MKV, AVI, FLV, WMV and HEVC are not guaranteed.

**Implementation constraints for search and column mode**

| Capability | Implementation |
|---|---|
| Search and replace | `@codemirror/search` panel and keymap; highlights and match count shown in the panel |
| Column mode | `rectangularSelection` for rectangular drag; `EditorSelection` multi-range plus a custom keymap for adding cursors and splitting by line |
| Undo consistency | Search replace, column edits and multi-cursor typing share the tab's undo stack and can be undone as a whole; encoding / EOL / BOM save path is untouched |
| Preview mode | Edit shortcuts are disabled in read-only preview so keys never go dead silently |
| Platform quirks | macOS `Option + drag` and some `Cmd+Alt` combinations may be captured by the system; verify on hardware and fall back to `Shift+Option+drag` / `Ctrl+Shift+↑↓` |

**Optional enhancements**: crash-safe drafts, auto-save toggle, command palette, file tree, theme switching, more language packs, installer and file associations, capture-group references in regex replace.

## Session Restore

**Location**: resolved through Tauri's `app_config_dir()`, one codebase across platforms.

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\com.mzj.file-editor\session.json` |
| macOS | `~/Library/Application Support/com.mzj.file-editor/session.json` |

**Data structure** (paths and view state only, never file contents):

```json
{
  "version": 1,
  "activeId": "t2",
  "tabs": [
    {
      "id": "t2",
      "path": "D:/notes/readme.md",
      "title": "readme.md",
      "dirty": false,
      "encoding": "UTF-8",
      "eol": "CRLF",
      "hasBom": false,
      "mtime": 1762412345000,
      "cursor": 128,
      "scrollTop": 640
    }
  ],
  "recent": ["D:/notes/readme.md"],
  "updatedAt": 1762412400000
}
```

**When it is written**: on tab add/remove/switch, active tab change, cursor and scroll changes, debounced by roughly 400 ms; a forced flush on the window `Destroyed` event. The session file itself is written through a temp file and replace so an abrupt exit cannot leave broken JSON.

**Restore validation**:

| Case | Handling |
|---|---|
| Path missing, inaccessible or moved | Shows a "file lost" placeholder tab instead of dropping it silently |
| Over size limit or binary | Skipped with a status bar notice |
| Session JSON corrupt or version mismatch | Falls back to an empty window, never crashes |
| `mtime` differs from disk | Reloads from disk; disk wins |

**Startup order**: window first → read `session.json` asynchronously → restore tab bar (titles as placeholders) → create an editor view only for the active tab → keep other tabs as data until switched. No preview rendering, no full-text indexing on first paint.

**Exit handling**: if any tab is dirty, ask "Save all / Quit without saving / Cancel" and never lose data silently. Quitting without saving still records the paths, so the next launch opens the on-disk versions.

## Editing and Saving Pipeline

**Fields captured on read**

| Field | Purpose |
|---|---|
| `encoding` | Write back in the original encoding so GBK files on Chinese Windows never end up garbled |
| `eol` (CRLF / LF) | The editor normalizes to LF internally and restores the original on save |
| `hasBom` | Restore the UTF-8 BOM on save |
| `mtime` | Detect external modification before saving |
| `size` | Reject or open read-only when over the limit |

Decode order: UTF-8 BOM → strict UTF-8 → `chardetng`, with `WINDOWS_1252` falling back to GBK.

**Save steps**

1. Compare the current `mtime` with the one recorded on open; on mismatch refuse to overwrite silently and offer "Reopen / Overwrite anyway".
2. Normalize editor content to LF, then restore CRLF if the file used it.
3. Encode bytes with the original `encoding`, adding BOM when needed.
4. Create a temp file in the **same directory** → write → `sync_all` → atomic replace.
5. On success return the new `mtime`, clear the dirty flag, update the status bar.
6. On failure keep the content and dirty flag, and keep the tab open.

**Other rules**

- New tabs are named `未命名-N`; the first save opens the native Save As dialog.
- Closing a dirty tab or the window uses the same "Save / Don't save / Cancel" logic; macOS `Cmd+W`, `Cmd+Q` and Windows window close share it.
- Default size limit is 100 MB (configurable); CodeMirror's viewport rendering handles very long lines. PDF / Word 100 MB, images 40 MB, audio 100 MB fallback.
- Read-only files and missing permissions produce an explicit error instead of pretending the save succeeded.

## Multi-tab State Model

| Field | Description |
|---|---|
| `id` / `path` / `title` | Identity and display; an empty `path` means an unsaved new tab |
| `dirty` | Drives the `*` marker, close confirmation and exit interception |
| `encoding` / `eol` / `hasBom` / `mtime` | Original file attributes needed by the save path |
| `cursor` / `scrollTop` | Used for session restore; column and multi-cursor state live inside `editorState` |
| `editorState` | CodeMirror `EditorState`, holding the document, selections (including multi-cursor) and its own undo stack |
| `previewMode` | Edit or preview |

The app holds exactly **one** `EditorView` globally: on tab switch the current state is stored back into the tab object and the target state is loaded into the same view. Inactive tabs keep only text and undo stacks with no DOM, so memory per extra tab stays small.

## UI and Shortcuts

Layout: tab bar with a new-tab button → toolbar (open / save / find / replace / preview toggle / column-mode indicator) → editor or preview → status bar. Light theme by default, minimum window size 900×600; macOS uses the system menu bar, Windows uses the in-app tab bar.

| Action | Windows | macOS |
|---|---|---|
| New tab | `Ctrl+N` | `Cmd+N` |
| Open file | `Ctrl+O` | `Cmd+O` |
| Save | `Ctrl+S` | `Cmd+S` |
| Save as | `Ctrl+Shift+S` | `Cmd+Shift+S` |
| Close tab | `Ctrl+W` | `Cmd+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` | `Ctrl+Tab` / `Ctrl+Shift+Tab` (`Cmd+Tab` belongs to the system) |
| Find | `Ctrl+F` | `Cmd+F` |
| Find next / previous | `F3` / `Shift+F3` | `Cmd+G` / `Cmd+Shift+G` |
| Replace / replace all | `Ctrl+H` / `Ctrl+Alt+Enter` | `Cmd+Alt+F` / `Cmd+Alt+Enter` |
| Rectangular drag select | `Alt + left drag` | `Option + left drag` (`Shift+Option+drag` if taken) |
| Add cursor above / below | `Ctrl+Alt+↑` / `Ctrl+Alt+↓` | `Cmd+Alt+↑` / `Cmd+Alt+↓` (`Ctrl+Shift+↑↓` if taken) |
| Split selected lines into cursors | `Ctrl+Shift+L` | `Cmd+Shift+L` |
| Leave column mode / single cursor | `Esc` | `Esc` |
| Toggle Markdown preview | `Ctrl+E` | `Cmd+E` |
| Quit | Close window | `Cmd+Q` |

Status bar: line:column, character count, encoding, EOL, language mode, cursor count (column mode state when active), saved / unsaved.

## Directory Structure

```text
fEditor/
├── README.md                    Chinese docs (usage + design spec)
├── README.en.md                 English docs
├── index.html                   Frontend entry
├── package.json                 pnpm scripts and frontend dependencies
├── pnpm-lock.yaml               Locked dependencies
├── tsconfig.json                TypeScript configuration
├── vite.config.ts               Vite build configuration
├── src/                         Vanilla TS frontend
├── public/                      Static assets
├── src-tauri/                   Rust shell
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json          Window, bundle and permission configuration
│   ├── capabilities/            Permission declarations
│   ├── icons/                   App icons
│   └── src/                     Rust business code
├── launcher/                    Single-file launcher (Rust)
├── dist/                        Frontend build output
├── node_modules/                Dependencies
└── scripts/                     All launch and build scripts
    ├── start.bat                Windows launch
    ├── start.sh                 macOS / Linux launch
    ├── start.command            macOS double-click launch
    ├── build-single.bat         Windows single-file packaging
    └── register-context-menu.bat  Explorer context menu registration
```

**Root configuration files**

| File | Purpose | Constraint |
|---|---|---|
| `package.json` | pnpm scripts, dependencies, app metadata | Must stay at the root; pnpm and the Tauri CLI locate the project here |
| `pnpm-lock.yaml` | Locked dependency versions | Same level as `package.json` |
| `tsconfig.json` | TypeScript compile and path configuration | Must stay at the root; `tsc` looks here by default |
| `vite.config.ts` | Build entry, port, output directory | Must stay at the root; Vite looks here by default |
| `index.html` | Vite entry page | Must stay at the root |

The toolchain reads all of these from fixed locations; moving them breaks `pnpm dev` / `pnpm build` / `pnpm tauri`. They stay where they are and are documented here instead.

## Development and Build

```bash
pnpm install
pnpm dev        # browser debugging
pnpm tauri dev  # Tauri window debugging
pnpm build      # type check + frontend build
pnpm tauri build
```

Windows single-file packaging and context menu registration:

```bash
scripts\build-single.bat            # produces dist-build\fEditor.exe
scripts\register-context-menu.bat   # registers the Explorer context menu
```

## Launch

- macOS: `./scripts/start.command` (double-click) or `./scripts/start.sh`
- Windows: `scripts\start.bat`

The launch scripts prefer an existing release build (fastest) and fall back to `pnpm tauri dev` when no build exists (installing dependencies on first run).

Every script switches to the project root first, so it works from any location.

## Cross-platform and Delivery

| Difference | Handling |
|---|---|
| Launch | Windows double-clicks `scripts/start.bat`, macOS runs `scripts/start.sh`; prefer the release build, fall back to `pnpm tauri dev`; no installer |
| Script details | bat files use CRLF and ASCII-only messages; sh files use UTF-8 + LF and Chinese messages; both prepend `~/.cargo/bin` to PATH |
| Shortcuts | Code checks `metaKey \|\| ctrlKey`; `Cmd+Tab` belongs to the system, so tab switching always uses `Ctrl+Tab` |
| Column shortcuts | macOS `Option` drag and `Cmd+Alt` may be taken by the system; verify on hardware and provide fallbacks |
| Config directory | `app_config_dir()`, no hardcoded paths |
| Drag and drop | Windows `C:\...`, macOS `/Users/...`; `file://` URLs are decoded and canonicalized |
| Native dialogs | One interface across platforms |
| Window and menu | macOS needs a menu bar (close tab / quit); Windows uses the in-app tab bar |
| File association | Phase one passes paths via CLI arguments; installer plus registry / `CFBundleDocumentTypes` is an optional enhancement |
| Signing | Unsigned Windows builds trigger SmartScreen; unsigned macOS builds are blocked by Gatekeeper, so release requires signing plus notarization |

**Build strategy**: Windows builds with `pnpm tauri build` on a Windows machine; macOS cannot be cross-compiled from Windows (Xcode / WKWebView / signing chain required), so the default is CI with dual runners (`windows-latest` + `macos-latest`) producing `.exe` and `.dmg`.

## Milestones

| Phase | Scope | Verification |
|---|---|---|
| S0 | Decisions, spec, launch scripts | Scripts pass the guard-branch smoke test |
| S1 | Project skeleton + single-tab open/edit/save | UTF-8 and GBK files survive save; CRLF and BOM preserved; external changes blocked |
| S2 | Multi-tab + session restore + exit interception | Tabs and cursors restored after restart; dirty tabs block exit |
| S3 | Toggle preview, search and replace, column mode, status bar, shortcuts, drag and drop | Feature-by-feature acceptance, with emphasis on `.txt` for search and column editing |
| S4 | Dual-platform packaging, icons, CI, launch script integration | Both artifacts produced and launched on real machines |

Each step is verifiable on its own; changes are never piled up in one go.

## Risks and Open Questions

| Item | Status | Suggestion |
|---|---|---|
| macOS signing and notarization certificates | Availability unconfirmed | Ship an unsigned `.app` for the beta, add signing before general release |
| CI runner availability | Unconfirmed | Prefer dual runners if CI access exists; otherwise document local macOS build steps |
| Session restore vs. unsaved content | No draft store | Later add a draft area and define draft-vs-disk conflict rules |
| Highlighting scope | Markdown / JSON / YAML / TOML | Add language packs on demand; always reject binaries |
| Column shortcut conflicts | macOS `Option` / `Cmd+Alt` may be taken | Verify on hardware, provide fallbacks |
| Regex replace scope | Basic match and replace | Capture-group references such as `$1` later |
| WebView2 dependency | Built into Win11, older Win10 may lack it | Note it in delivery docs; add an Evergreen bootstrap if needed |

## Acceptance Checklist

- [ ] Double-click or CLI path opens a `.md` file directly
- [ ] `.txt` files open, edit and save; GBK txt stays intact and CRLF is preserved
- [ ] Search and replace inside `.txt`: case sensitive, whole word, regex, replace in selection, replace all
- [ ] Column mode in `.txt`: rectangular selection followed by multi-cursor typing / deleting
- [ ] Column edits and bulk replace can be undone as a whole; undo stacks never cross tabs
- [ ] Launch restores tabs, active tab, cursor and scroll position
- [ ] Tabs keep independent undo stacks and dirty flags; switching never loses the cursor
- [ ] `Ctrl/Cmd+S` keeps encoding, EOL and BOM exactly as opened
- [ ] Saving after an external modification is blocked instead of silently overwriting
- [ ] A failed save never leaves a truncated file
- [ ] Closing a dirty tab or quitting asks first, never loses text
- [ ] Toggle preview renders correctly, filters dangerous HTML and disables edit shortcuts
- [ ] Images open in preview with fit-to-window, zoom buttons and 1:1 working
- [ ] MP4 / WebM stream, seek and change playback speed
- [ ] PDF / DOCX / image / media tabs never interfere with text tabs
- [ ] `scripts/start.bat` / `scripts/start.sh` launch the release build when present and give a clear message or fall back to dev mode when absent
- [ ] One launchable artifact each for Windows and macOS
- [ ] Release artifact size and idle memory stay within budget
