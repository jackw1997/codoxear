import { Palette, palette } from '../model/Theme';

interface HelpSection { title: string; items: string[]; }
const HELP_SECTIONS: HelpSection[] = [
  {
    "title": "Sessions",
    "items": [
      "Choose a conversation from the sidebar. Swipe left for Edit and Duplicate, or right for Delete. Long-press a session to open its actions.",
      "Tap the conversation title to rename it, adjust priority, snooze it, or wait for another session. Waiting and Later groups separate blocked and snoozed conversations.",
      "The sidebar shows the backend and model, with badges for starting, failed, lost, unattended, queued and unread messages. A filled dot indicates a busy session.",
      "Details shows backend, provider, model, reasoning, queue and token information. Copy conversation copies the conversation text."
    ]
  },
  {
    "title": "New session",
    "items": [
      "Choose Codex, Pi or Claude, a working directory, provider, model and reasoning level. Available choices come from your server.",
      "Start a fresh conversation or select an available conversation to resume for that backend and directory. You can use tmux and, in a Git repository, create a worktree branch.",
      "The last backend and each backend’s provider/model choices are remembered on this device. Duplicate starts a fresh session with the selected conversation’s launch settings."
    ]
  },
  {
    "title": "Messages and queue",
    "items": [
      "Send submits immediately, including while the agent is busy. Queue saves the prompt for later. Open Queue to review, edit, reorder or remove queued prompts; the server sends them when the session becomes idle.",
      "Ctrl+Enter or Cmd+Enter sends from the message box. Enter adds a line. When a command menu is open, Up/Down selects an entry and Enter chooses it; Escape dismisses the menu.",
      "On a Pi session, /model changes the model and /effort changes the reasoning level; /thinking is an alias. Type to filter the available choices.",
      "Load older messages fetches history. Latest returns to the newest turn. Search finds conversation text; Previous and Next move between matches, including older result pages. The conversation’s arrow controls move between user messages.",
      "Tool and thinking counts accumulate during a turn. The separate ▸ count shows currently running subagents and may decrease when a worker finishes."
    ]
  },
  {
    "title": "Keyboard navigation",
    "items": [
      "Outside text fields, press f to show hints on visible, enabled controls. Type the displayed hint to activate a control. Escape or Backspace cancels hints.",
      "Stable hints include 1–9 for visible sessions; s sidebar; b files; d details; u unattended; / search; p/n previous/next user message; g latest; a attach; q queue; e send; i message box; c new session; h help; w settings; l log out. Only available controls receive hints.",
      "Without hints: i focuses the message box; j/k scroll down/up; d/u scroll roughly half a page; G returns to latest; D asks to delete the current session; / opens search.",
      "Escape leaves the message box without clearing its draft. Escape keeps dialogs and search open: use Close, Cancel, or f and the displayed hint. Tab moves between controls in the open dialog. In forms and help, a button’s first distinctive letter activates it when no text field has focus; for Close and Copy conversation, use l and o. The file viewer keeps its Vim keys."
    ]
  },
  {
    "title": "Unattended mode",
    "items": [
      "Unattended is a per-session idle nudge. Enable it in the conversation’s Unattended controls and optionally add a request to the shared continuation prompt.",
      "Cooldown is the number of idle minutes after the assistant finishes before another prompt is injected. Each injection uses one unit of the remaining budget; reaching zero disables unattended mode.",
      "The server runs unattended mode even when this app is closed. Enabled sessions show an unattended badge. Settings contains the shared prompt used across sessions."
    ]
  },
  {
    "title": "Files",
    "items": [
      "Files opens recent, changed or searched files. Text supports source, editing and Git diff where available; Markdown also has Preview. Resolvable file paths in messages open the file and any specified line.",
      "Edit starts in INSERT mode. Escape enters NORMAL mode. h/j/k/l, w/b/e, 0/$ and gg/G move the cursor; Ctrl+d/Ctrl+u move several lines. i/a/A resumes typing; x deletes a character, dd deletes a line, and o/O opens a line.",
      "u undoes and Ctrl+r redoes in NORMAL mode. Ctrl+Z or Cmd+Z undoes in INSERT mode; add Shift to redo. Ctrl+S or Cmd+S saves, and Ctrl+F or Cmd+F opens Find. The system text-selection menu provides copy and paste.",
      "File tabs preserve unsaved edits and undo history. Reload asks before discarding changes and clears undo history. Close asks before discarding an edited buffer; Escape does not discard it.",
      "Images have zoom and fit controls. PDF supports pages, zoom and text search. Video uses native playback controls. Download saves through the system file picker; Full screen expands the viewer."
    ]
  },
  {
    "title": "Attachments and recovery",
    "items": [
      "Attach opens the system file or photo picker. Selected files are staged for the current session; Remove attachment removes an item before sending. Send stays disabled while an upload is in progress.",
      "An upload failure keeps your draft. If the server received the file but its response was lost, the app checks the staged attachments before you retry.",
      "Message drafts are kept per server and session. Unsaved text-file drafts are kept on this device and can be recovered after restarting.",
      "If a send acknowledgment is lost, the server may already have received the prompt. Check the transcript and use the recovery controls before retrying; clearing the warning does not resend the prompt."
    ]
  },
  {
    "title": "Announcements and notifications",
    "items": [
      "Announcement plays the shared server audio stream for completed responses. Settings controls narration announcements and the OpenAI-compatible API base URL and API key used for summarization and speech.",
      "Notification enables alerts on this device, subject to system permission. Tap an alert to open its conversation; if signed out, log in to the same server first.",
      "Background notifications require a configured Huawei push service. Without it, Settings reports foreground-only delivery: alerts require the app to stay open. Enabling notifications does not make foreground-only delivery work after the app is closed.",
      "Settings Save applies voice changes; Cancel discards them. Leaving an existing API key blank keeps it; the explicit clear control removes it."
    ]
  },
  {
    "title": "Appearance",
    "items": [
      "Settings offers Clay, Slate and Paper in light, dark or system mode. The choice is remembered on this device.",
      "Custom CSS translates supported theme and component styles to native controls. Unsupported rules are reported beside the editor."
    ]
  }
];

@Component
export struct HelpContent {
  @Prop colors: Palette = palette('clay', false);
  build() {
    Column({ space: 20 }) {
      ForEach(HELP_SECTIONS, (section: HelpSection) => {
        Column({ space: 10 }) {
          Text(section.title).id('help-' + section.title).fontSize(14).fontColor(this.colors.muted).width('100%')
          ForEach(section.items, (item: string) => {
            Row({ space: 8 }) {
              Text('•').fontSize(14).lineHeight(22).fontColor(this.colors.text)
              Text(item).fontSize(14).lineHeight(22).fontColor(this.colors.text).layoutWeight(1)
            }.alignItems(VerticalAlign.Top).width('100%')
          })
        }.width('100%')
      }, (section: HelpSection) => section.title)
    }.width('100%')
  }
}
