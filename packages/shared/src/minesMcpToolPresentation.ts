export type MinesMcpToolLogo = "mines";

export interface MinesMcpToolPresentation {
  readonly displayName: string;
  readonly logo: MinesMcpToolLogo;
}

export type MinesMcpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "workflow-stop"
  | "background-wait"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "write-pr-guides"
  | "read-pr-guide"
  | "browser"
  | "device"
  | "html-preview"
  | "html-render";

export interface MinesMcpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "mines" | "browser" | "device" | "pull-request";
  readonly summaryAction: MinesMcpToolSummaryAction;
}

function tool(
  labels: MinesMcpToolDefinition["labels"],
  summaryAction: MinesMcpToolSummaryAction,
  icon: MinesMcpToolDefinition["icon"] = "mines",
  displayName = `${labels[0]} ${labels[3]}`,
): MinesMcpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

const MINES_MCP_SERVER_ALIASES = new Set(["mines", "t3-code", "t3_code", "t3code"]);

const MINES_MCP_TOOLS: Readonly<Record<string, MinesMcpToolDefinition>> = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Unwatching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  write_pull_request_guides: tool(
    ["Write", "Writing", "Started writing", "review guides"],
    "write-pr-guides",
    "pull-request",
  ),
  read_pull_request_guide: tool(
    ["Read", "Reading", "Read", "a review guide"],
    "read-pr-guide",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(
    ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  create_threads: tool(["Create", "Creating", "Created", "mines"], "thread-create"),
  mines_thread_start: tool(["Start", "Starting", "Started", "a mine"], "thread-create"),
  mines_thread_list: tool(["List", "Listing", "Listed", "mines"], "thread-list"),
  mines_thread_read: tool(["Read", "Reading", "Read", "a mine"], "thread-read"),
  mines_thread_send: tool(["Send", "Sending", "Sent", "to a mine"], "thread-send"),
  mines_thread_wait: tool(["Wait", "Waiting", "Waited", "for a mine"], "thread-wait"),
  mines_workflow_stop: tool(
    ["Stop", "Stopping", "Requested a stop for", "a workflow"],
    "workflow-stop",
  ),
  mines_background_wait: tool(
    ["Update", "Updating", "Updated", "background waits"],
    "background-wait",
  ),
  mines_thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a mine"],
    "thread-interrupt",
  ),
  mines_worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "mine to a git worktree"],
    "worktree-handoff",
  ),
  mines_worktree_status: tool(["Get", "Getting", "Got", "mine worktree status"], "worktree-status"),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  mines_queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  mines_queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  mines_queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  mines_queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  mines_queue_reorder: tool(
    ["Reorder", "Reordering", "Reordered", "a queued run"],
    "queue-reorder",
  ),
  mines_queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  mines_pending_request_list: tool(
    ["List", "Listing", "Listed", "pending questions"],
    "question-list",
  ),
  mines_pending_request_read: tool(
    ["Read", "Reading", "Read", "pending questions"],
    "question-read",
  ),
  mines_pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  mines_thread_configuration: tool(
    ["Read", "Reading", "Read", "mine configuration"],
    "thread-configuration",
  ),
  mines_thread_configure: tool(["Set", "Setting", "Set", "mine model"], "thread-configure"),
  mines_thread_fork: tool(["Fork", "Forking", "Requested a fork of", "this mine"], "thread-fork"),
  mines_thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "mine context"],
    "thread-merge",
  ),
  mines_thread_search: tool(["Search", "Searching", "Searched", "mine content"], "thread-search"),
  mines_thread_transfers: tool(["Read", "Reading", "Read", "mine transfers"], "thread-transfers"),
  mines_thread_organize: tool(["Organize", "Organizing", "Organized", "a mine"], "thread-organize"),
  mines_thread_update: tool(["Update", "Updating", "Updated", "mine metadata"], "thread-update"),
  mines_worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  mines_preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  mines_preview_close: tool(["Close", "Closing", "Closed", "a preview tab"], "browser", "browser"),
  mines_environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  mines_environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  mines_thread_launch: tool(["Launch", "Launching", "Launched", "a project mine"], "thread-create"),
  mines_project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  mines_project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  mines_project_create: tool(
    ["Register", "Registering", "Registered", "a project"],
    "project-create",
  ),
  mines_project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  mines_project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  mines_project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  mines_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  mines_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  mines_thread_send_attachments: tool(
    ["Send", "Sending", "Sent", "attachments"],
    "attachment-send",
  ),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
};

export const MINES_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(MINES_MCP_TOOLS));

function normalizeMinesMcpToolLabel(value: string): string {
  return value
    .replace(
      /t3_(thread|workflow|background|worktree|queue|pending_request|preview|environment|project|attachment)/g,
      "mines_$1",
    )
    .replace(/\s+(?:complete|completed)\s*$/i, "")
    .trim();
}

// ACP tool prefixes vary; match loosely but require a known display-name entry.
function resolveMinesMcpToolName(value: string): string | null {
  const label = normalizeMinesMcpToolLabel(value);
  if (Object.hasOwn(MINES_MCP_TOOLS, label)) return label;
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      MINES_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch =
    /^(?<server>mines|t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(label);
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  const prefixed = /^(?:mcp[-_]{1,2})?(?:mines|t3[-_ ]?code)(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(
    label,
  );
  const candidate = prefixed?.groups?.tool ?? label;
  if (Object.hasOwn(MINES_MCP_TOOLS, candidate)) return candidate;
  // OpenCode 2 thread prefixes can contain underscores; choose the longest known tool-name suffix.
  if (!/^(?:mines|t3-code)-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(MINES_MCP_TOOLS)) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

export function resolveMinesMcpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveMinesMcpToolName(toolName);
  return name !== null && Object.hasOwn(MINES_MCP_TOOLS, name) ? name : null;
}

export function resolveMinesMcpToolDefinition(
  toolName: string | null | undefined,
): MinesMcpToolDefinition | null {
  const name = toolName == null ? null : resolveMinesMcpToolName(toolName);
  return name !== null && Object.hasOwn(MINES_MCP_TOOLS, name) ? MINES_MCP_TOOLS[name]! : null;
}

export function resolveMinesMcpToolPresentation(
  toolName: string | null | undefined,
): MinesMcpToolPresentation | null {
  const definition = resolveMinesMcpToolDefinition(toolName);
  return definition === null ? null : { displayName: definition.displayName, logo: "mines" };
}
