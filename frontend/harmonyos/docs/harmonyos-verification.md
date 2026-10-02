# HarmonyOS native client verification

Status: implementation in progress. This is not a parity acceptance report.

The delivery contract is a full native ArkUI client, matching the web client’s
features and appearance, with no ArkWeb, and adaptation for slab, dual fold,
wide fold and triple fold devices. The matrix below tracks unfinished scope;
an unchecked item remains required, rather than being removed from delivery.

## Test boundary

Server, broker, transcript and file tests run in isolated Docker containers in
context `colima-codoxear-test`; the native preview uses `codoxear-harmony-test`
on host loopback port 19743, with its authentication/transcript bridge on 19744.
Automated tests use owned fixtures, never host runtime sockets or host session
logs. Separate user-requested phone diagnosis inspected the user’s active
conversation inside that preview container; its broker was preserved.
Synthetic fixture acknowledgments do not prove a model ran. Separate real CLI
tests install the CLIs and copy only required authentication/provider configuration
into the disposable container, following the repository Docker test skill.
Credentials are not included in artifacts or source control.

Native automation uses the DevEco HarmonyOS 6.1.1/API 24 simulator.
Debug signing and installation succeeded on a physical HOP-AL10 phone
(HarmonyOS 6.1.0.135, API24) on 2026-10-02. Login, restored user messages and
Session Details were exercised on that phone. Later custom dropdown, math
highlight and draft updates have not yet been installed on it. Current UI
automation uses only dedicated target 127.0.0.1:15558; other emulators and the
phone remain reserved for the user. Release signing and AppGallery test
distribution are pending Huawei account login; the prepared unsigned release
artifact is not installable. Full physical-device acceptance remains open.

Screenshots are raw simulator captures. Evidence boards embed these captures
inside explicitly schematic device frames; the frames do not claim to be
physical photographs or exact device bezel dimensions.

## Feature matrix

| Area | Implemented and exercised | Required work still open |
| --- | --- | --- |
| Authentication | Endpoint-scoped login/logout; real HTTP 401 returns to login and preserves four-line local draft; stale cookie/401 isolation model tests; real 503 reconnect; rejected offline send preserves multiline draft across restart and explicit retry delivers once; 120s outage keeps editable draft, background/return and automatic reconnect preserve it without auto-send | Remaining recovery interaction parity |
| Session list | Catalog, selected session, rename, theme persistence; native swipe Edit/Duplicate actions and badges; removed selected sessions clear stale controls while retaining local drafts | Ordering/group parity |
| Launch | Backend/provider/model/effort/fast/resume/worktree/tmux form; provider/model restart persistence; all three backend launch failure/dismissal; actual Pi/Codex/Claude tmux creation, deletion and explicit resume with old history and real new replies | Start-fresh environment and metadata-delay edge cases |
| Session edits | Name, priority, snooze, dependency controls; actual 4-hour Later grouping and Waiting dependency/clear; priority limits/reset, custom-date validation/save/reopen, tomorrow at local 09:00 and clearing snooze verified | Exact web interaction parity |
| Conversation | Real server tail, send acknowledgment, SSE; native Marked parsing with nested styles, GFM tables/tasks, links and local image | Remaining Markdown completeness, embedded media and scroll edge cases |
| Runtime status | Token/context, cumulative activity and child detail model; replay tests; actual overlapping catalog/live counts, closed-turn reset and log rebind; child details update at unchanged count and each completion removes only that child | Remaining backend telemetry parity |
| Composer | Per-session drafts, fold/restart/auth-expiry restore, typed command menu; four-line composer growth and Ctrl+Enter/Esc; cross-client edits and clears, native writes and newer remote drafts after restart verified | Full keyboard behavior, overflow scrolling and all backend commands |
| Delivery | Lost acknowledgment after server commit preserves draft and warns; explicit clear does not resend; upload blocks Send; uncertainty and explicit clear survive process restart; staged attachment injection rejection retains file/draft across restart and explicit retry commits once | Remaining recovery interactions |
| Queue | Add/edit/delete and persisted reorder through native UI; duplicate mutation/stale read tests; real unknown acknowledgment locks edits/moves and deletion preserves later prompts for review; missing-broker recovery requires explicit deletion and disappears after restart; open queue tracks Sending, locks mutations, removes confirmed prompts automatically | Remaining interaction parity |
| Search/history | Server search and cursored history model; actual result-to-message jump and previous/next user navigation; 202-message search and older-page anchor verified; previous/next match across older-result pages and native text highlighting; atomic inline/display math highlighting and clearing verified in Slate dark and Clay light | Remaining boundary navigation coverage |
| Attachments | Native document and gallery pickers, upload and removal; filename/byte hashes; delayed rejection, draft retention, explicit retry, lost-response reconciliation and session-switch isolation verified; staged file send opt-in, injection rejection/restart/retry verified | Remaining attachment interaction parity |
| Text files | Native syntax view, edit, Vim modes/motions, undo/redo, find/replace, save, create, tabs, Markdown preview/source and system-picker download; heading and cross-file line links; Ctrl+S/Ctrl+F | Remaining language grammar acceptance and editor parity |
| File safety | 409 conflict preserves buffer; discard and reload confirmation; drafts and undo retained across tabs; Chinese/emoji drafts survive force-stop with original conflict token; recovery listing, reload cancel/confirm and history reset verified | Remaining editor performance and physical-device acceptance (1.212 MB active typing, undo/redo, migration/restart/save verified) |
| Git | Changed files and actual HEAD diff; tracked raw-byte text/binary and nested untracked paths verified | Exact theme diff layout and remaining path cases |
| PDF | Native PDFKit render, text search, page controls, zoom interaction; fullscreen rotation retains page; switching PDFs reloads the controller; 240-page last-page search; corrupt-file errors and encrypted-password retry/unlock/switch | Remaining PDF interaction parity |
| Images/video | Authenticated inline image and file preview; image zoom/fit controls; H.264 native playback paused at 1 s, aspect ratio preserved; image fullscreen/zoom and editor rotation continuity verified; actual pinch/pan/double-tap; PNG/PDF/MP4 system export byte integrity; video pause/resume, rotation, background return and file switching; damaged image/video errors and switching back to valid media | Remaining format compatibility |
| Appearance | Clay/slate/paper light/dark; six-mode icon/underline contrast pixel checks; local persistence; actual OS light/dark transitions and explicit override; all seven dropdowns use reusable native ArkUI custom controls, six palettes and keyboard selection/dismissal verified | Component geometry, custom style translation, 1:1 screenshot comparison |
| Voice | Native AVPlayer authenticated HLS reached playing with generated silence; listener/logout races; native Save/Cancel, blank credential preservation, explicit clear and masked reopen across restarts | Real TTS speech and reconnect/interruption |
| Notifications | Native permission, foreground delivery, warm tap and cold-start login routing verified in system shade; native PushKit and authenticated backend registration implemented; token ownership/race and provider-contract tests; logout/permission race test | Signed Huawei project/WORK entitlement and real background/offline provider delivery |
| Unattended | Session/global configuration, validation, rejected Save retains fields and server state, explicit retry, rejected automatic injection consumes no budget; two successful injections 60.26 seconds apart, native form shows zero/disabled after depletion | Remaining cross-session interaction parity |
| Export/copy | Full conversation copy and native paste verified; message count, known size-limit formatter and stale-export tests; actual export413 explains the configured limit and preserves clipboard/conversation | Remaining export interaction parity |
| Help/accessibility | Nine-section native help, ordinary-dialog distinctive-letter activation, control labels, system back; hardware Esc/i/u/G/search/delete-confirm/MetaEnter, modal Tab containment, f hints for visible scoped controls and Unicode/wrapped Markdown links; themed confirmations with isolated hints, Tab containment, explicit c/d; dirty-editor Escape/Keep/Discard verified | Remaining file-viewer shortcuts, hint controls and accessibility |
| Screen adaptation | Wide fold, dual fold inner/outer and triple fold single/double/full draft continuity; slab chat and clipboard | Rotation, keyboard edge cases, pane/scroll continuity and physical device |

## Evidence and checks

- `tests/native_ui.py` drives actual `hdc uitest` controls. Each dump and capture
  uses a unique remote path to avoid stale simulator artifacts.
- `tests/model_behavior.cjs` executes transpiled ArkTS models with platform I/O
  mocked at its boundary. It verifies editor history, tokenization, drafts,
  send/save races, transcript replacement, stale search, history windows,
  runtime counter replay and backend command capabilities.
- `tests/fixture_backend.py` runs only inside the isolated container.
- The SDK `assembleHap` build is required after ArkTS changes. A build pass is
  not a substitute for native interaction tests.
- Existing framed evidence covers authenticated chat on the wide fold’s two
  screens, file editing, PDF search, Git diff and queue editing.

## Acceptance still required

Complete the open matrix items, run the appropriate repository checks inside
Docker, exercise all app workflows, compare native/web captures at equivalent
viewport sizes across all theme modes, and test the connected physical device.
No claim of pixel parity or full testing is warranted by the current evidence.

## Additional evidence (2026-10-02)

- Slab device system Documents download and re-upload of `example.py` preserved
  all 209 bytes. Source, downloaded file and server upload SHA-256:
  `952e6f43ddd8f770cd5775d349e4f5f914dce0abb4f8632e22f0acd693a76d8a`.
- Native upload filename appeared in the composer; Remove attachment removed it.
- Existing backend baseline `744f3eca055d88a057b8825dc77cd086f991066b` passed
  **1953 tests and 112 subtests** in a separate Docker container, with a writable
  clone, npm dependencies and Node available to subprocesses with a cleared PATH.
  Initial read-only-checkout and missing default-PATH Node failures were resolved
  by correcting that test environment. This is backend regression evidence,
  not acceptance of the new native implementation.

- A Docker-only fault proxy on loopback 19744 injected real HTTP 401 responses.
  The native app returned to login with an expiry message and restored the exact
  four-line draft after reauthentication. Endpoint generation tests additionally
  reject stale login cookies, stale 401 callbacks and late send acknowledgments.
- Native Marked rendering was visually inspected with nested bold/italic,
  strikethrough, task lists, escaped table pipes, Chinese text and an authenticated
  local PNG. Rendering uses ArkUI text, shapes and images; no HTML or WebView.
- Actual previous/next user controls aligned the corresponding message at the
  top of the list. Selecting a search hit aligned its target message likewise.
- Native video playback displayed the synthetic H.264 test pattern and advanced
  from 00:00 to 00:01 before pause. Image + / Fit controls showed 150% / 100%.

- Native MathJax SVG output rendered through ArkUI Image/ImageSpan was inspected
  for inline energy/fractions, display integrals, matrices and sums. Currency and
  code spans remained literal. This verifies rendering, not KaTeX pixel parity.
- Native queue move-down persisted the expected reverse order on the server.
- A real Docker proxy 503 produced the reconnect banner; removing the fault
  restored the connection without login and preserved the exact draft.

- Native scrolling now follows the latest message on selection and on incoming
  content, including delayed image sizing. A new reply did not move the viewport
  while reading an older user message. Loading older history preserved the first
  visible message at exactly the same physical y-coordinate (682).
- Native code-block coloring was visually inspected on a Python sample; keyword
  and string colors appeared correctly. The later highlight.js grammar implementation supersedes this initial heuristic
  lexer; full language acceptance remains open.

- PhotoViewPicker selected a real system screenshot with a media-provider URI.
  All 418040 bytes matched the server upload (SHA-256
  `8e22ed8f873e289516fe737f0b9d8380eaee343a4bbdccfe1a427cd32e2c8a31`).
  An 8-second proxy delay showed upload progress and disabled Send. Model tests
  cover partial reads, truncation, cancellation and a connection change during
  the system save picker.
- Dropping the HTTP connection after a successful backend send produced the
  uncertain-send warning and preserved the exact draft. The fixture log contained
  one user message. Keep checking retained the warning; explicit clear removed
  it without sending again. Proxy fault flags were removed after the test.
- A system notification was tapped while a different session was selected;
  the app opened the notification's correct conversation. Endpoint mismatch
  and missing-session routing also have behavioral model coverage.

- Lost-ack uncertainty and the exact draft survived forced process termination and
  login. Explicit clear also survived a second restart, without resubmission.
- Native Pi, Codex and Claude Code launch failure paths displayed errors and
  dismissed the failed records. These intentionally unavailable backend launches
  verify failure recovery, not successful real model startup.
- Per-server backend/provider/model choices survived form reopen and process
  restart. Invalid normalized dates have behavioral rejection coverage.

- Search navigated from match 41/100 to 40/100 across an older-results boundary
  and back; matching native text spans visibly highlighted without losing styles.
- Ctrl+Enter sent one prompt and cleared the composer; Esc preserved its draft.
- Unattended rejected cooldown 0; cooldown 1/budget 1 produced exactly one
  fixture-log injection. Reopening showed disabled and remaining 0; the test
  configuration was then reset to disabled defaults.
- Disposing voice settings during the first API request prevents the subsequent
  global-prompt read/write; both load and save have behavioral race coverage.

- Native editor NORMAL/INSERT, gg/dd, undo/redo and dirty Esc were exercised
  through `tests/native_editor.py`, with the test file restored after save.
- Launch directory suggestions, Git branch display and selecting an existing
  resume candidate were exercised. Later real CLI tests below cover successful native resume for all three backends.
- A draft survived opening a second file and switching back. Canceling Reload
  retained it; confirming Reload restored the server copy. Markdown file preview,
  source and edit modes were exercised. File drafts now also persist in app-private storage; the later recovery checks cover process termination.
- Custom CSS theme variables have behavioral tests for cascade priority, variable
  references, mode/width conditions, invalid values and color/geometry conversion.
  Full component CSS and native visual acceptance remain open.

- Native CSS light/dark/restart controls and message selector styles were visually
  inspected. User and assistant messages show distinct custom text/background
  colors, border, font size, spacing and corner radius. CSS remains a subset.
- Highlight.js now emits grammar-driven native spans; models cover multiline
  Python strings, TypeScript/ArkTS, embedded JavaScript and source preservation.
  The actual file viewer showed both lines of a Python triple-quoted string
  colored consistently. Unknown or oversized input falls back to plain text.
- Binary and over-limit text files showed the download-only UI with distinct
  reasons. The later 3,000,000-byte export below verifies the large-text path.

- Grammar-driven highlighting now uses highlight.js 11.11.1 with a native token
  emitter. Native Python multiline strings, comments, keywords and numeric literals
  were inspected; model checks cover embedded JavaScript and Unicode preservation.
- Binary and over-limit text files show download actions. A 3,000,000-byte Docker
  fixture exported through the system Documents picker matched the server SHA-256:
  `13564e2843d782b044bbf382964f9baf9486fc94fb872aa15daba152b0a1c96b`.

- `native_file_navigation.py` passed heading/return links, cross-file `#L40`
  scrolling to the actual source row, Ctrl+S/Ctrl+F and undo after switching tabs.
- `native_file_recovery.py` passed exact multiline Chinese/emoji draft recovery
  after process termination. A concurrent server edit produced a conflict on save,
  retaining the local draft; reload cancel preserved it, confirmed reload reset
  undo history, and saving removed recovery data across a second restart.
- `native_file_fullscreen.py` passed PDF fullscreen, page continuity through
  rotation, switching between PDFs with different page counts, image fullscreen
  at 150%, and unsaved editor text surviving landscape/portrait transitions.
  Raw captures and the framed recovery/rotation board were visually inspected.

- Changed-range editor undo/redo passed native NORMAL/INSERT, gg/dd, u/Ctrl+R,
  dirty Escape and reset/save regression after the implementation replacement.
- Actual two-finger image gesture reached 348%, panning moved image pixels, and
  double-tap returned to 100%. PNG, two-page PDF and MP4 exports through the
  native Documents picker matched server SHA-256 byte for byte.
- Native/web Clay-light chat comparison uses matching approximately 377×749
  content viewports. Corrected short-message width, line height, timestamp,
  navigation/action order and moved conversation copy to Details. Hardware
  keyboard regression passed again after these changes. Font and other page
  comparisons remain open; this is not a pixel-parity acceptance.

- Native notification survived a forced process stop. Tapping it opened login with the matching server; authentication then selected the correct conversation (`native_notification_cold_start.py`).
- Keyboard resize mode kept the chat header, navigation and composer visible above the actual system IME, preserving a Chinese/English draft after dismissal. Tapping the conversation title opened its edit form.

- File recovery can be opened from the Files panel without reopening the original path. Saving removes the recovered entry; stale listing data cannot overwrite a newer draft.
- `native_file_view_state.py` verified per-file search, source scroll, editing mode and caret after switching away and back. Adjacent typing is grouped into one Undo operation; redo and replacement boundaries have behavioral model coverage.
- The source viewer lazily creates visible rows. A 12,000-line, 1,212,000-byte file opened and completed a UI dump in 2.74 seconds on the slab simulator. Explicit native TextArea length configuration prevents the observed 1,000,000-character truncation. Full-buffer Unicode editing, undo/redo, forced-process recovery and an exact-byte save were exercised; The complete repeatable test and subsequent selection test are recorded below.
- Actual Pi 0.84.4 (`glm-5.2`) and Codex 0.159.3 (`gpt-6-astra`) direct Docker launches bound transcript logs and returned their requested unique reply markers. These API checks do not yet establish native launch, tmux or resume acceptance. Claude Code 2.1.277 (`sonnet`) also returned its requested marker after completing its first-run prompts inside the container.
- Latest repeatable large-editor run passed the complete 1,212,000-byte source → Unicode edit → Undo/Redo → force-stop → recovered file → exact-byte server save → restored original workflow (`native_large_editor.py`). Saved modified SHA256: `141222fa0495cecbb3b1715a972383d230a8103d68fc284d278e1d0eac9fda5d`; original restored SHA256: `fb2f3e64e3e4aa73bb5b071928e3d9f851f874c5c165dc1033c70c1420f68354`. Precise Find selection is tested separately.
- Actual native sends and rendered real model replies passed for all three Docker CLIs (`native_real_cli.py`). Native new-session forms also successfully created tmux sessions for Pi, Codex and Claude Code, automatically selected them, and displayed real replies (`native_launch_real.py`). Subsequent native deletion and explicit resume passed for all three backends, including exact tmux pane termination, original conversation IDs, restored old replies and real new replies.
- Codex 0.159.3 stores visible user messages in retained `response_item` records. The backend now recognizes explicit `user.text` provenance, excludes environment/internal content, and feeds the same user boundary to chat, sidebar, live, history and idle reducers. Fresh-server HTTP plus actual native UI displayed both prompt and reply (`native_codex_retained.py`). This requires the updated backend, not only a new HAP. The temporary parser-validation HTTP server had background workers stopped and was terminated after the read-only UI check.
- Updated backend Docker regression: **1957 tests and 112 subtests passed**. The disposable test checkout contains a fixture Git commit for deployment-script tests; no host deployment or host Git commit was made.

- Claude Code 2.1.277 can keep the old transcript closed after `--resume` until the first new turn. The broker now resolves that explicitly requested log before sending; a real native deletion → resume → old history → new model reply passed after the fix. Unresolved/new-session requests do not guess an old log.
- Updated backend regression after the resume fix: **1959 tests and 112 subtests passed** inside Docker.
- `native_message_copy.py` passed tap-to-reveal copy, exact single-message clipboard paste, and Session details → Copy conversation → paste containing both old and resumed user/assistant turns. Native inline text taps now reach the bubble copy control without intercepting file links.
- `native_find_selection.py` passed Find Next selecting the actual matched range, Backspace deleting only that range, and Undo restoring the exact original text.

- `native_offline_send.py` passed a real 503-rejected Send: no user message reached the server, the Chinese/English multiline draft survived forced termination and login, and explicit retry created exactly one user message and cleared the composer. Fault injection was removed in a finally block.

- After the focus-order fix, `native_file_view_state.py` passed again: per-file Find query, source scroll, NORMAL mode, caret and Undo all survive tab switches.
- `native_code_search.py` opened a code match and preserved the full code text. The raw screenshot was inspected: the exact searched Chinese/emoji range has a yellow background across multiple syntax-colored native spans. Model tests additionally cover literal punctuation and matches crossing line boundaries.

- `native_voice_settings.py` passed actual Settings Save, restart with an empty masked key field, Cancel without modifying server settings, blank-key Save preserving the synthetic saved key, and explicit Clear removing it. The test refused to replace any preexisting credential and restored the original Docker-only settings in a finally block. No actual TTS inference was exercised.

- API24 native text measurement returned a negative sentinel for empty hard-break
  fragments, collapsing some multiline bubbles. The width accumulator now skips
  empty fragments and falls back to the maximum width on invalid measurements.
  `native_multiline_bubble.py` passed an actual 935×348-pixel multiline reply;
  code-search UI passed again with a fresh short identifier.
- `native_chat_references.py` passed automatically recognized prose `file:40`
  opening the native source at line 40 and a rendered memory citation opening a
  Docker-only `~/.codex/memories/` fixture at line 40. Explicit reference paths
  are resolved by the server before opening; late results cannot cross sessions.

- `native_reference_choice.py` passed same-name source choices, selecting the
  correct file at line 40, and directory links opening a prefilled launch form
  without creating a session.
- The compact file viewer now measures the available source/edit/preview area
  after its toolbars, including keyboard and rotation changes. Native tab state,
  PDF fullscreen/page continuity/rotation, cross-PDF reload, image zoom and
  unsaved editor rotation checks passed. This is a geometry improvement, not
  completed web pixel parity.
- Accepted sends retain their acknowledged state when a subsequent refresh
  fails. Enqueue distinguishes immediate send, queued and commit-unknown
  responses; behavioral checks cover all three results and refresh failure.

- Compact file toolbar regression passed heading and cross-file line jumps, horizontal tab scrolling, Ctrl+S/Ctrl+F and per-tab Undo. Native PDF/image/editor fullscreen and rotation tests passed after the height/layout changes.
- `native_queue_recovery.py` passed against a real Docker broker that committed input and lost its response before transcript flush. Edit/reorder remain disabled; cancellation retains records, and deleting unknown input quarantines remaining prompts. Explicit deletion of both recovery records caused no additional input.
- `native_large_pdf.py` passed on a generated 240-page, 897456-byte PDF. First-page display took 2.65 s; full-document search reached the unique target on page 240. Adjacent pages, fullscreen rotation and switching back to a two-page document all passed.

- `native_video_lifecycle.py` passed play/pause on a 30-second H.264 fixture, paused-position retention through fullscreen rotation, resume, Home/foreground return, and switching to a four-second clip with position reset to zero.
- CSS padding shorthand now resolves custom properties after cascading. Model checks cover scoped values, nested fallbacks, longhand overrides and `!important`; `native_css_padding.py` verified a 5vp→35vp change increases both bubble dimensions by 60vp (210 physical pixels), then restored empty custom CSS.

- `native_system_theme.py` switched the actual HarmonyOS display setting, confirmed the selected OS mode, and sampled native Settings pixels: clay paper changed from RGB(255,253,249) to RGB(38,33,27). Explicit app light mode survived subsequent OS changes; System resumed following dark mode. The test restored OS and app light.
- PDFKit returns parse status codes without necessarily throwing. The native viewer now handles these codes, offers a masked password field, clears submitted passwords, disables unloaded controls and releases documents. `native_pdf_errors.py` passed corrupt-file error, incorrect-password retry, successful two-page unlock and switching away/back requiring a new password.

- `native_orphan_queue.py` verified durable unknown input with the broker removed: Send/edit/reorder locked, Cancel preserved both records, individual deletion preserved the remainder, and final deletion cleared selection and stayed gone after restart.
- `native_session_removal.py` verified catalog removal closes stale selected-session controls; the exact unsent draft remained recoverable when the same isolated fixture was recreated.
- System-theme checks now sample both the status and bottom gesture areas. Both follow the native theme, including explicit overrides.
- `native_path_token.py` verified a filename containing a non-UTF-8 byte through prose lookup, line jump, Unicode/emoji editing, force-stop recovery, exact server-byte save, reload and original restoration.
- `native_path_scope.py` verified Git-discovered paths from a nested session working directory, including the same raw-byte identity through edit/save/reload, plus an explicit outside-directory link to line40. Search discovery mode does not imply repository-root-relative coordinates.

- Native file drafts now use independent atomic files with a small index. A
  1.2 MB unsaved Unicode buffer created in the previous HAP survived an in-place
  upgrade to the new storage format, recovered exactly, and saved to the Docker
  server with matching bytes. The original fixture was restored afterward.
  Model checks cover short writes, failed replacement, legacy migration and
  editing a small buffer without rewriting another large draft. Writing the
  active buffer remains synchronous; this is not a general performance claim.
- The new draft format also passed native forced-restart recovery with a remote
  edit, HTTP 409 conflict, Reload cancellation/confirmation, undo reset and
  removal from recovery after save.
- Hardware Escape preserves the session form, file browser and discard
  confirmation. In the focused editor it exits insertion mode without losing
  text. Explicit Keep editing and Discard controls complete the intended action.

- All six native themes passed real pixel checks for contrasting icon strokes,
  transparent SVG interiors and the primary button fill. Visual review then
  found and corrected default-black link decorations; all six modes then
  passed the final underline/contrast checks. Actual framed screenshots were delivered.
- Native hardware-key regression passed Escape blur, i focus, literal typing,
  u/G navigation, search, modal Tab containment and Escape preservation, delete
  confirmation, and Meta+Enter delivery.
- Native Git verification opened tracked non-UTF-8 text and binary filenames
  from a nested working directory, displaying the correct HEAD diff/binary
  notice. Untracked non-UTF-8 paths opened relative to the session directory.
  Binary line counts display unknown (+? / -?) rather than false zero counts.
  The temporary broker and session row were removed after verification.

- Native session settings passed priority minimum/maximum/reset, invalid custom
  date rejection, exact date/time save and reopen, tomorrow at local 09:00,
  and clearing snooze. The original fixture settings were restored.

## Native keyboard hints and preview handoff (2026-10-02)

- Native `f` hints register actually visible controls in the active surface.
  Numeric session selection, fixed shell keys, editable-field isolation, modal
  scope, Escape/Backspace cancellation, touch and target movement cancellation
  were exercised with `native_keyboard_hints.py`, `native_hint_viewers.py` and
  `native_hint_forms.py`. Select hints focus the native selector; Enter opens it.
- `native_modal_policy.py` verified Escape preserves forms, search, unsaved
  editor content and discard confirmation; explicit Keep/Discard remain required.
- `native_inline_hints.py` verified native Text layout rectangles for a wrapped
  Chinese/emoji link following an inline formula, then opened source line 40
  through its actual keyboard hint. The captured screen was visually inspected.
- A frozen unsigned emulator preview (SHA-256
  `eec24c25ca0c4a36b8ba6cdddc8423e01d39c0964d5b0178632a27855d567ed2`)
  was delivered to the user. It predates inline-link hints and remains installed
  on Codoxear_Slab at HDC target 127.0.0.1:5555. Further native UI work uses
  Codoxear_Workbench at 127.0.0.1:15556; set `CODOXEAR_HDC_TARGET` for tests.
  This handoff is a preview, not full parity acceptance or a signed phone build.

## Visual and PushKit continuation (2026-10-02)

- Native code blocks now use a plain preformatted surface with touch/hover Copy.
  Actual clipboard, local image, Markdown Source/Preview, explicit cross-file
  references, ambiguous filename selection and the wrapped Unicode/math link
  to line 40 passed after the visual changes. Hardware navigation/history passed
  again. Table widths use native intrinsic text measurement; transcript rows
  include day headers and grouped message spacing.
- Equivalent web/native content was captured and delivered with schematic phone
  frames. It remains a comparison artifact, not acceptance of pixel parity:
  font metrics, inline-code padding/borders, long-table wrapping, compound
  quote/list layout and composer geometry remain open.
- PushKit server registration is independent of Web Push subscriptions. Tests
  execute PS256 signing and verify it with the RSA public key, exercise private
  persistence/rotation/stale disable, provider business-code handling, invalid
  token removal, payload byte limits, telemetry write failure, authenticated
  routes and native-only final-response dispatch. No real provider credential
  was used. Full backend regression passed **1977 tests and 112 subtests** in a
  fresh writable Docker snapshot after installing the declared test dependencies.
- `native_push_behavior.cjs` executes the actual ArkTS token owner with SDK/I/O
  mocks: opt-in, restart, token rotation, lost acknowledgement, both revocation
  paths, failed revocation, fallback, incomplete local write and lifecycle races
  passed. Provider acceptance and physical delivery remain unverified; see
  [native-push-design.md](native-push-design.md) for the provisioning contract.
- Fresh server container `codoxear-harmony-push-test` on loopback 19745 passed
  actual unauthenticated 401, authenticated configuration status and idempotent
  unregister. User preview 5555 and its server/proxy were not replaced.

- Final native build passed. `native_push_settings.py` exercised actual permission
  enablement, unconfigured-server foreground-only status, opt-in restoration after
  force-stop/login, and disabling notifications. `native_notification_cold_start.py`
  posted a real local system notification, stopped the application process, tapped
  the notification in the system shade, authenticated and reached the exact
  originating conversation. This establishes click routing, not Huawei background
  delivery. The dedicated server on 19745 was stopped after verification.

## Large editor response improvement (2026-10-02)

- Native timing on Workbench15556 exposed a character-by-character undo diff
  scan across the full 1,212,000-byte document. Comparing equal blocks before
  finding the exact UTF-16 edit boundaries reduced observed history/state-update
  median from 34 ms to 1 ms. Recorded peaks were 43 ms before and 26 ms after;
  synchronous draft persistence remained at a 5 ms median with occasional peaks.
  These are development emulator samples, not end-to-end input latency or a
  physical-device benchmark. Temporary timing code was removed afterward.
- `native_large_editor.py --typing-probe` passed 20 individual hardware-key
  insertions and 20 deletions, Unicode end-of-file editing, Undo/Redo, process
  termination, exact restored contents, byte-for-byte server save, and restoration
  of the original test file. UI-driver time includes hdc/uitest overhead.
- Model checks execute edits at block boundaries, inside surrogate pairs and at
  either end of a large mixed Unicode document, then undo/redo every version.
  Model checks and the clean SDK build passed. Preview5555 remains unchanged.

### Attachment failure recovery verification — 2026-10-02
- Native upload errors from a previous session/auth epoch no longer surface in the newly selected session. A failed upload reconciles authoritative staging without resending; catalog staging and attachment reads use generations to reject obsolete responses and recover after a longer outage.
- Model regression covers late errors, lost acknowledgments, read ordering, and catalog recovery (78568 PASS); clean SDK build96056 PASS.
- Actual Workbench15556 UI test native_upload_failures.py52573 PASS: delayed rejection disables Send and preserves draft; explicit retry succeeds; response loss after server commit recovers one staged attachment; switching sessions during a rejected upload keeps the new view clean. Native screenshot: artifacts/harmonyos/native-upload-rejected.png (workspace artifact).
- Dedicated fault proxy19746 stopped, fixture attachment/draft removed, normal19744 login restored (24219 PASS). Protected preview5555/19744 was not changed. No claim of complete attachment/web parity.

### Native help and dialog keyboard — 2026-10-02
- HelpContent renders nine native ArkUI sections: sessions, launch, messages/queue, keyboard navigation, unattended, files, attachment/recovery, announcements/notifications and appearance. Guidance describes the current unconditional Send flow and native foreground/background notification distinction. It does not copy the web help’s stale busy-send choice or browser-only push guidance.
- SDK76556 and real UI97777 PASS: scrolling reaches every section; Escape retains Help; f exposes only Close and its hint exits. Actual captures native-help-top.png/native-help-bottom.png, workspace artifacts.
- KeyboardHints supports the web first-distinctive-character rule for ordinary native dialog buttons. Fields, disabled/background/offscreen controls and active hint mode are excluded. File viewer retains its Vim key handling; system confirmation shortcuts remain open scope.
- Model71500 and SDK18148 PASS. Real UI native_dialog_keys.py33210 PASS: c closes Help, c is ambiguous between Close/Copy conversation while Shift+L closes, letters remain literal in a focused form field, Tab then c closes without saving, existing f/b and Escape policies retain behavior. No preview5555 installation.


### Sidebar continuation — 2026-10-02
- Two-row session cards expose backend/model/effort/age metadata, with finite timestamp fallback and model compaction. Header/logo, phone-width drawer, group counts, theme-specific backend SVGs and footer geometry now follow the web tokens more closely. Swipe actions use native icon controls.
- SessionStateDot uses native animation for busy/pending; suppressed rows stay filled and idle rows hollow. Actual busy fixture pixel samples varied across six frames (88135 PASS).
- Reduced-motion acceptance FAILED (77577): switching the emulator's transition animations OFF did not stop the dot. Temporary instrumentation showed AccessibilityKit's reduced-motion query still returned false; no callback was observed. Instrumentation was removed, and API failures now conservatively use a static dot. Actual OS transition animations were restored ON (57066 PASS). This remains an explicit unresolved compatibility item.
- Clean SDK71053 and model96164 passed. Actual native_sidebar.py23410 PASS: five-second keyboard-hint continuity across polling, Help hint/direct close, notification settings shortcut, swipe Edit/Duplicate visibility, Edit close, Delete cancellation and selection. Presentation-only row keys prevent irrelevant priority/telemetry refreshes from destroying active hint/swipe controls; actions resolve the latest session snapshot. Original preview5555 is preserved; development uses15556. The test helper now defaults to the development target.

- Synthetic motion broker1112623 was verified by exact command line, stopped, and its catalog record removed after tests. OS transition animation setting remains restored ON. Second unsigned emulator preview SHA-256: `060179f4ae265d9db027833115af80ec5bd74eb93a54c7d77253756b24f9ad61` (SDK71053, 7,438,816 bytes). This remains a preview, not full parity acceptance.

## Send boundaries and live queue correction (2026-10-02)

- Development moved to a third emulator, Codoxear_Development15557; user previews5555/15556 remain untouched. Authentication and port forwarding verified.
- Actual native send with a staged file failed409 because the request omitted allow_pending_attachment. Reproduced74653; fixed explicit staged-file opt-in, legacy-pending confirmation, and a queue guard. SDK77687/model9373 PASS. Actual attachment tests15331 and57023 PASS their attachment phase: injected broker502 preserves file/draft across force-stop/login; explicit retry commits exactly once and clears staging/draft. No automatic retry.
- Actual queue test38361 found open dialog never refreshed its queue list. Polling now reloads an open queue unless a mutation is underway; existing read-generation guards reject stale responses. SDK1405/model2150 PASS. Actual queue93142 PASS Sending state, locked head edit/delete/move, blocked movement across head, and both prompts committed once/disappeared after acknowledgement. First fixture wait was corrected for the real10s idle grace; the following prompt temporarily receives the server recovery flag while the head is committing, which the UI correctly honors.
- Tests use only Docker-native-send-boundary broker and explicit15557 UI actions. Screenshots native-attachment-injection-rejected.png, native-attachment-injection-retried.png, native-queue-sending.png, native-queue-sent.png. No production backend or protected preview device changed.

## Native confirmation controls (2026-10-02)

- Seven system-alert call sites now share a themed native CustomDialog with its own KeyboardHints provider. Initial real UI execution exposed a duplicate-provider crash; the SDK's documented allowOverride provider option fixed it. SDK76093 PASS.
- Actual native_confirmation_keys.py8594 PASS: Escape retains the dialog, four Tab presses remain inside it, c cancels without queue mutation, f exposes only two confirmation choices, Escape exits hints, and d explicitly deletes without sending. Screenshot native-confirmation-hints.png was visually inspected.
- Actual native_modal_policy.py59131 PASS on the same HAP: unsaved session/file search contents survive Escape; dirty editor leaves insertion mode without discarding; Keep editing preserves the buffer and explicit Discard closes it.

## Unattended failure and cooldown boundaries (2026-10-02)

- native_unattended_boundaries.py14584 PASS on development15557 through dedicated Docker proxy19746. A503 Save preserves prompt, cooldown1, remaining2 and old server configuration; explicit retry persists the edited configuration. Two synthetic broker rejections leave budget2 and no committed user event.
- After clearing the dedicated broker fault, first success leaves budget1. No second commit occurs in the first45s; independent broker transcript timestamps show the two successes60.26s apart. Reopened native form shows remaining0 and the switch off. Finally disables only the dedicated fixture and clears only its fault.
- Screenshots native-unattended-save-rejected.png, native-unattended-one-remaining.png, native-unattended-exhausted.png. No production/protected preview fault injection.

## Prolonged network outage (2026-10-02)

- native_prolonged_outage.py38833 PASS against dedicated Docker19746 and development15557. After rejected Send the native reconnect banner remains visible, the multiline Unicode/emoji draft stays editable and survives background/return. At60s and120s, no user event was committed and the exact draft remains.
- Restoring connectivity clears the reconnect banner without submitting; explicit Send commits exactly once and clears the composer. Screenshots native-prolonged-outage.png and native-prolonged-outage-recovered.png. Dedicated proxy fault cleared in finally.

## Runtime counter reconciliation (2026-10-02)

- Actual native_runtime_boundaries.py29182 reproduced catalog tools3 but native tools6: live increments were added to a catalog total already containing those increments. Activity now keeps separate catalog and cursor totals, seeds the cursor baseline once, displays their maximum and keeps cursor turn boundaries independent of catalog busy flags. Clone preserves both totals.
- Model84627 and SDK35081 PASS. Native3859 PASS on15557: tools3→4 without replay inflation; thinking1.2k→1.5k; completed turn hides activity; next human turn shows tools1/thinking200; actual broker log rebind replaces old transcript, tool count, thinking70 and context. Test uses server percent_remaining (which includes reserved context), not naive token/window division.
- Screenshots native-runtime-counters.png/native-runtime-rebound.png. Dedicated broker sidecar restored and busyflag cleared in finally. Protectedpreview2.1 still contains the old count implementation; subsequent package must identify the fix separately.

## Native image and PDF keyboard hints (2026-10-02)

- Image zoom/fit actions and PDF password/search inputs now participate in scoped keyboard hints. Input focus suppresses command hints so literal f stays in the field. Native Row wrappers preserve usable input width.
- SDK90663 and native_media_hints.py52377 PASS on development15557: zoom100→150→100/fit, encrypted PDF password focus/unlock/page navigation, search field focus and literal f, full-document search to page240. Screenshots native-image-hints.png and native-pdf-search-hints.png visually inspected. Background chat controls absent from hints; disabled final-page Next page omitted.
- Latest changes remain development-only; frozen downloadable2.1 has not been replaced.

## Native child telemetry (2026-10-02)

- native_child_telemetry.py62824 PASS against a dedicated Docker-only synthetic Pi broker: idle parent shows two active children, role/model/tools/token details refresh while count remains2, first completion removes only that child, final completion removes activity. These are synthetic lifecycle records, not model inference or actual delegated agents.
- Screenshot native-child-telemetry.png and native-child-complete.png retained. The exact fixture PID was verified and terminated in finally; its status record and catalog entry removed. Protected previews unchanged.

## Legacy pending attachment (2026-10-02)

- native_legacy_attachment.py60485 PASS with a fresh isolated Docker19748 server initialized from an old pending_attachments.json entry, without staged attachment records. Cancel preserves draft/pending state and commits nothing; Send with attachment commits exactly once, clears pending and draft. Actual confirmation/sent screenshots retained.
- Dedicated codoxear-native-legacy-attachment stopped after verification; development15557 restored to protected19744. No shared runtime files or faults on preview backend.

## Native media decoder failures (2026-10-02)

- Image and video decoder errors now display a native explanatory message. Image zoom/fit actions are disabled and excluded from hints after failure. Changing the source resets the error state.
- SDK92968 and native_media_errors.py53777 PASS on15557: damaged PNG/MP4 errors, disabled image actions, switch to valid image and zoom, valid video playback advances, return to broken tabs displays the errors. First test attempt17294 incorrectly included chat timestamps in video labels; corrected to inspect the Video subtree.
- Screenshots native-image-decode-error.png/native-video-decode-error.png retained. Image capture visually inspected. Frozen2.1 remains unchanged.

- Same SDK92968 HAP passed native_video_lifecycle.py34498: play/pause, fullscreen rotation preserves position, resume, background paused state and source replacement.

## Conversation export limit (2026-10-02)

- native_export_limit.py86146 PASS with dedicated Docker19749 configured to a real1024-byte transcript export limit. Actual HTTP413 includes max_bytes1024; native Copy conversation explains the1KiB limit. Pasting after failure confirms the previous clipboard content remains exact, and server transcript still contains its original two messages. No prompts sent.
- Screenshot native-conversation-export-limit.png retained. Dedicated codoxear-native-export-limit stopped; development15557 restored to protected19744. No app change required.
- Preview2.2 (SDK92968) frozen at7498690bytes, SHA256a6d98721eb544bf10d6ebf422879783da52d8c92c7adea745a9a4cc1dcc76b84; LAN download from a separate Docker network returned200 and the exact hash. Earlier packages and both reserved preview emulators preserved.

## Structured session details (2026-10-02)

- Native Details replaces raw diagnostics JSON with Model / Reasoning effort controls, Session and Context usage sections, and a collapsed technical section. Uses existing palette, spacing, button treatment and scoped keyboard hints. Failed launch text remains readable.
- Settings reuse backend capability detection and catalog choices. Codex uses the typed settings route; Pi/Claude Code send their existing settings command without replacing the composer's draft. Pending attachments/messages prevent command injection. No optimistic rewrite of current-turn model telemetry; successful Codex changes are labelled for the next turn.
- Model20744 and SDK69561 PASS. Actual dedicated15558 UI verified cancel sends no request, model/effort produce the exact Docker fixture control requests, draft preserved, technical disclosure opens/closes, and a real server rejection shows an error without success feedback. Native30680 covered settings, continuation45384 covered disclosure/error; native_details.py's scroll visibility threshold was corrected after it rejected a fully visible bottom button. Earlier34104 hit a UI automation timeout.
- Real testing found ArkUI Builder value capture left Apply disabled after selecting effort; changed button availability and dynamic labels to reactive callbacks, then rebuilt and verified. Screenshots details-top.png/details-change.png/details-expanded.png/details-error.png retained in workspace artifacts.
- Current user's Codex session does not advertise live settings; its controls are intentionally disabled with an explanation. Fixture verification does not claim that unsupported CLI sessions gained live-setting support.
- Signed HAP SHA256 f184bd575ed081ce6913b96561a5eb539623dbf40277fab9150e37646ba2d5a1. Physical install attempt at16:12 found device disconnected; no phone update yet. Preview packages and user-reserved emulators unchanged.

- Physical delivery16:22: USB reconnected, exact signed HAP installed successfully; actual login restored the existing selected session. Real phone Details11532 PASS and screenshot visually checked (physical-phone-session-details.png). Current Codex model/effort displayed correctly with unsupported live controls disabled.

### 2026-10-02 — real Codex model/effort controls

Investigated the physical-phone conversation `broker-1852406`: Codex 0.159.3 had launched without a remote app-server and correctly advertised no live settings. The Docker preview and sandbox images omitted `websockets`, despite its presence in `pyproject.toml`; a fresh startup probe reproduced `ModuleNotFoundError`. Added the dependency to both Dockerfiles and installed websockets 16.1.1 in the running isolated preview container, without restarting any user process. A fresh capability probe then passed.

On dedicated emulator 15558, a newly created real Codex test session `broker-2046844` exposed both buttons. The actual native Details UI changed reasoning to medium and model to gpt-6.1-sol. Its next real response completed, Details displayed both effective values, and authoritative Codex turn_context changed from gpt-6-astra/low to gpt-6.1-sol/medium. Screenshots: `artifacts/harmonyos/details-real-codex-settings.png` and `details-real-codex-applied.png`. Eight existing Codex control/RPC tests passed in Docker. Only this dedicated test session was deleted afterwards; the user's original broker and CLI stayed running.

No HAP change/reinstallation is required. Existing embedded-TUI sessions still need to be resumed under a new remote-capable broker before these controls become available; the current user's conversation was not restarted. Dockerfile edits are preserved for future image builds; the images themselves were not rebuilt during this fix.

### App-owned dropdowns (2026-10-02)

- Replaced all seven native Select controls (launch provider/model/effort/resume, session snooze/dependency, Details setting) with `components/ui/ThemeDropdown.ets`.
- Trigger, chevron, option list, selected mark, focus and hover styling use the current shared Palette, including Paper's square corners and Clay/Slate radii. The OS popup only positions custom content. Toggle tracks/thumbs and priority slider now also use Palette colors.
- Actual dedicated emulator 15558: all six family/mode combinations passed text/arrow/background pixel assertions plus popup readability, selection, and dismissal after selection. Four cases passed run58355; remaining Clay/Paper Light passed64133 after pinning the test cwd (a newly discovered fixture legitimately changed the server's default cwd and removed resume choices). No session was created by these checks.
- Build41418 passed in22.365s; this adds the final border/radius ordering correction over build34412. Physical phone deployment is still pending USB reconnection; emulator evidence is not a phone installation claim.
- Reusable API documented next to the component in `components/ui/README.md`. No theme-specific copies of behavioral logic are needed.
- Final build56225 passed23.445s. Actual integration60296 passed Details choice/cancel without settings dispatch; snooze Custom fields; long dependency list scroll and Back dismissal; keyboard Down/Enter selection; Escape and outside dismissal preserving the value. Follow-up95330 passed Space open/commit and Up navigation. Explicit Enter/Space handling fixes the native Button default not committing keyboard selection.
- Dedicated synthetic broker native-dropdown PID2187382 and its socket/metadata were cleaned up; original user broker1852406 and CLI1852698 remain running. No conversation was restarted or sent a message.
- Final signed package: `artifacts/harmonyos/theme-components-20261002/Codoxear-theme-components-signed.hap` (workspace-relative), SHA256 `8b4803ff263dd714189cd4410d535a6aae4c51b4373e2323e4cde0cb739d07da`. Screenshot `dropdown-slate-dark-menu-final.png` is the final app-owned menu. Phone still absent; USB handoff requested.

## Latest verification, 2026-10-02 evening

- Fresh current-source Docker regression passed **1977 tests and 112 subtests**
  in 45.35 seconds. This supersedes the baseline-only result above. The dedicated
  regression container was removed; the active preview and user brokers were
  preserved. This verifies backend tests, not complete native parity.
- `tests/native_math_search.py` exercised inline/display formula matches through
  actual search controls in Slate dark and Clay light, then verified clearing
  restores the original rendering. SVG glyph/layout and cache isolation are
  also covered by the model harness.
- AppGallery preparation and remaining account actions are documented in
  [appgallery-distribution.md](appgallery-distribution.md). No store upload or
  release-signed installation has occurred.

- `tests/native_draft_sync.py` passed actual native UI + second authenticated HTTP
  client verification: initial remote text, live remote edits/clears, native writes,
  forced restart, and remote edits/clears while the app was closed. No prompts
  were sent; its owned synthetic fixture was cleaned up. The first run exposed
  programmatic TextArea change events being treated as new edits; identical
  changes are now ignored and the complete test passed after rebuilding.
- Draft model coverage includes persisted timestamp/baseline, missing remote
  record versus deletion, failed-write retry, serialized writes and reads racing
  with typing/login. This follows server timestamp/last-writer semantics; it is
  not collaborative character-level merging. Debug SDK build and unsigned
  release APP packaging both passed with this change.
