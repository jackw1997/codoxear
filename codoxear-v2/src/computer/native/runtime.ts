import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../../contracts/model.js";
import { Launch, type Operation } from "../../contracts/tunnel.js";
import type { Notification } from "../../protocol/notifications.js";
import type { Runtime } from "../runtime.js";
import { backendHomes } from "./homes.js";
import { ensureStateDirectory, socketPath } from "./paths.js";
import { backendCommand } from "./backend.js";
import { readTranscript, scanLogs } from "./logs.js";
import type { Backend, BrokerLaunch, Metadata } from "./types.js";
import { NativeSidebar } from "./workspace/sidebar.js";
const validId = (id: string) => /^broker-[a-f0-9]{32}$/.test(id);
export class NativeRuntime implements Runtime {
  readonly kind = "native" as const;
  readonly directory: string;
  constructor(
    public readonly home: string,
    public readonly workspace: string,
    public readonly stateHome = home,
  ) {
    if (!isAbsolute(home) || !isAbsolute(workspace))
      throw Error("Native home and workspace must be absolute paths");
    this.directory = ensureStateDirectory(stateHome);
  }
  async supportsProviderLaunch() {
    return true;
  }
  close() {} // PTYs belong to independent broker processes, not the Computer connection.
  private metadata(id: string): Metadata {
    if (!validId(id))
      throw new DomainError(404, "not_found", "Unknown native session");
    try {
      const meta = JSON.parse(
        readFileSync(join(this.directory, id + ".json"), "utf8"),
      ) as Metadata;
      if (meta.version !== 1 || meta.session_id !== id)
        throw Error("Invalid session metadata");
      return meta;
    } catch {
      throw new DomainError(404, "not_found", "Unknown native session");
    }
  }
  private listMetadata() {
    return readdirSync(this.directory)
      .filter((name) => /^broker-[a-f0-9]{32}\.json$/.test(name))
      .flatMap((name) => {
        try {
          return [this.metadata(name.slice(0, -5))];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.start_ts - a.start_ts);
  }
  private async control(
    id: string,
    operation: string,
    body: Record<string, unknown> = {},
  ) {
    this.metadata(id);
    return new Promise<any>((resolveResult, reject) => {
      let answer = "",
        finished = false;
      const socket = connect(socketPath(this.stateHome, id));
      const finish = (error?: Error, value?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolveResult(value);
      };
      const timer = setTimeout(
        () =>
          finish(
            new DomainError(
              504,
              "runtime_uncertain",
              "Native broker response timed out. Check the transcript before sending again.",
            ),
          ),
        15000,
      );
      socket.setEncoding("utf8");
      socket.on("connect", () =>
        socket.write(JSON.stringify({ operation, body }) + "\n"),
      );
      socket.on("data", (chunk) => {
        answer += chunk;
        if (answer.length > 2 * 1024 * 1024) {
          finish(Error("Native broker response too large"));
          return;
        }
        const newline = answer.indexOf("\n");
        if (newline < 0) return;
        try {
          const result = JSON.parse(answer.slice(0, newline));
          if (result.ok) finish(undefined, result.value);
          else
            finish(
              new DomainError(
                result.status ?? 400,
                result.code ?? "runtime_error",
                result.error ?? "Native broker failed",
              ),
            );
        } catch (error) {
          finish(error as Error);
        }
      });
      socket.on("error", () =>
        finish(
          new DomainError(
            409,
            "runtime_offline",
            "The native session is not running. Resume its saved session to continue.",
          ),
        ),
      );
      socket.on("end", () => {
        if (!finished)
          finish(
            new DomainError(
              504,
              "runtime_uncertain",
              "Native broker disconnected. Check the transcript before sending again.",
            ),
          );
      });
    });
  }
  private async launch(
    backend: Backend,
    name: string,
    options: unknown,
    terminalOwned = false,
  ) {
    const launch = Launch.strict().parse(options ?? {});
    let cwd = resolve(launch.cwd ?? this.workspace);
    if (launch.cwd && !isAbsolute(launch.cwd))
      throw new DomainError(
        400,
        "not_dispatched",
        "Working directory must be an absolute path",
      );
    if (!existsSync(cwd) || !statSync(cwd).isDirectory())
      throw new DomainError(
        400,
        "not_dispatched",
        "Working directory does not exist",
      );
    if (launch.worktree_branch) {
      if (launch.resume_session_id)
        throw new DomainError(
          400,
          "not_dispatched",
          "A resumed session cannot create a worktree",
        );
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(launch.worktree_branch) ||
        launch.worktree_branch.includes("..")
      )
        throw new DomainError(
          400,
          "not_dispatched",
          "Enter a valid worktree branch",
        );
      const target = join(
        this.home,
        ".local/share/codoxear-v2/worktrees",
        randomUUID(),
      );
      mkdirSync(dirname(target), { recursive: true });
      try {
        execFileSync(
          "git",
          ["-C", cwd, "worktree", "add", "-b", launch.worktree_branch, target],
          { stdio: "ignore" },
        );
        cwd = target;
      } catch {
        throw new DomainError(
          400,
          "not_dispatched",
          "Could not create the requested Git worktree",
        );
      }
    }
    const id = "broker-" + randomUUID().replace(/-/g, "");
    let resumePath: string | undefined;
    if (launch.resume_session_id) {
      const saved = scanLogs(this.home, backend).find(
        (row) => row.id === launch.resume_session_id && row.cwd === cwd,
      );
      if (!saved)
        throw new DomainError(
          400,
          "not_dispatched",
          "Resume session not found for this runtime and working directory",
        );
      if (
        this.listMetadata().some(
          (row) =>
            row.agent_backend === backend &&
            row.thread_id === saved.id &&
            row.readiness !== "exited" &&
            existsSync(socketPath(this.stateHome, row.session_id)),
        )
      )
        throw new DomainError(
          400,
          "not_dispatched",
          "Resume target is already running; select that agent instead",
        );
      resumePath = saved.path;
    }
    const input: BrokerLaunch = {
      home: this.home,
      storageHome: this.stateHome,
      sessionId: id,
      backend,
      cwd,
      name,
      launch,
      ...(resumePath ? { resumePath } : {}),
    };
    backendCommand(input, !terminalOwned); // Validate credentials/setup before starting any process.
    const directory = dirname(fileURLToPath(import.meta.url));
    const source = fileURLToPath(import.meta.url).endsWith(".ts");
    const broker = source
      ? join(directory, "broker.ts")
      : [
          join(directory, "computer/native/broker.js"),
          join(directory, "broker.js"),
          join(directory, "native/broker.js"),
        ].find(existsSync);
    if (!broker || !existsSync(broker))
      throw new DomainError(
        400,
        "not_dispatched",
        "Native broker is missing from the Computer package",
      );
    const child = spawn(
      process.execPath,
      [
        ...(source ? ["--import", import.meta.resolve("tsx")] : []),
        broker,
        ...(terminalOwned ? ["--terminal"] : []),
      ],
      { detached: true, stdio: ["pipe", "pipe", "pipe"], cwd: this.workspace },
    );
    const result = await new Promise<{ localId: string; brokerPid: number }>(
      (resolveReady, reject) => {
        let output = "",
          errorOutput = "",
          settled = false;
        const finish = (
          error?: Error,
          value?: { localId: string; brokerPid: number },
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          if (error) reject(error);
          else resolveReady(value!);
        };
        const timer = setTimeout(
          () =>
            finish(
              new DomainError(
                504,
                "runtime_uncertain",
                "Native launch outcome unknown. Check the Computer before creating another agent.",
              ),
            ),
          15000,
        );
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const newline = output.indexOf("\n");
          if (newline < 0) return;
          try {
            const ready = JSON.parse(output.slice(0, newline));
            if (ready.ready)
              finish(undefined, {
                localId: ready.localId,
                brokerPid: ready.brokerPid,
              });
          } catch {}
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          errorOutput = (errorOutput + chunk).slice(-4096);
        });
        child.on("error", () =>
          finish(
            new DomainError(
              400,
              "not_dispatched",
              "Native broker could not be started",
            ),
          ),
        );
        child.on("exit", () => {
          if (!settled)
            finish(
              new DomainError(
                400,
                "not_dispatched",
                errorOutput.includes("ENOENT")
                  ? "The runtime executable was not found on this Computer"
                  : "The native runtime exited before starting. Check its configuration in a local terminal.",
              ),
            );
        });
        child.stdin.end(JSON.stringify(input));
      },
    );
    return result;
  }
  async createTerminal(backend: Backend, name: string, launch: unknown = {}) {
    return this.launch(backend, name, launch, true);
  }
  private async catalogue() {
    const metadata = this.listMetadata();
    const activeIds = new Set(metadata.map((meta) => meta.session_id));
    const sidebar = new NativeSidebar(this.directory);
    const rows = await Promise.all(
      metadata.map(async (meta) => {
        let state: any = {};
        try {
          state = await this.control(meta.session_id, "state");
          delete state.tail;
        } catch {}
        const transcript = readTranscript(meta.log_path, meta.agent_backend);
        return {
          ...meta,
          ...state,
          thread_id:
            state.thread_id ??
            transcript.threadId ??
            meta.thread_id ??
            meta.session_id,
          owned: true,
          transport: "native",
          ...sidebar.project(
            meta.session_id,
            meta.alias,
            transcript.events.at(-1)?.ts ?? meta.start_ts,
            activeIds,
          ),
          queue_len: state.queue?.length ?? 0,
          token: state.token ?? transcript.token,
          log_exists: !!meta.log_path,
          lost: meta.readiness === "exited",
          pending_attachment: (state.attachments ?? []).length > 0,
          staged_attachments: state.attachments ?? [],
          files: [],
          draft_updated_ts: 0,
          thinking: transcript.thinking,
          thinking_tokens: transcript.thinkingTokens,
          tools: transcript.tools,
          system: transcript.system,
          subagents_running: transcript.subagents.filter(
            (agent) => agent.status === "running",
          ).length,
          subagent_details: transcript.subagents,
          unattended_enabled: state.unattended?.enabled ?? false,
          unattended_request: state.unattended?.request ?? "",
          slash_commands:
            meta.agent_backend === "pi"
              ? [
                  ...new Map(
                    [
                      ...[
                        "settings",
                        "model",
                        "tree",
                        "thinking",
                        "scoped-models",
                        "export",
                        "import",
                        "share",
                        "bug",
                        "copy",
                        "name",
                        "session",
                        "changelog",
                        "hotkeys",
                        "fork",
                        "clone",
                        "trust",
                        "login",
                        "logout",
                        "new",
                        "compact",
                        "resume",
                        "reload",
                        "quit",
                      ].map((name) => ({ name, description: "" })),
                      ...(state.slash_commands ?? []),
                    ].map((command) => [command.name, command]),
                  ).values(),
                ]
              : [
                  { name: "model", description: "Select model" },
                  ...(meta.agent_backend === "codex" &&
                  !state.codex_live_settings
                    ? []
                    : [
                        {
                          name: "effort",
                          description: "Select reasoning effort",
                        },
                      ]),
                  ...[
                    "help",
                    "compact",
                    "clear",
                    "cost",
                    "status",
                    "permissions",
                  ].map((name) => ({ name, description: "" })),
                ],
          pi_thinking_command: state.pi_thinking_command === true,
          readiness: state.readiness ?? meta.readiness,
          setup_message: state.setup_message ?? meta.setup_message,
        };
      }),
    );
    return {
      sessions: rows,
      new_session_defaults: this.defaults(),
      recent_cwds: [...new Set(rows.map((row) => row.cwd))],
      tmux_available: false,
    };
  }
  private defaults() {
    const homes = backendHomes(this.home);
    const codex: any = {
      model: null,
      model_provider: null,
      provider_choice: null,
      provider_choices: ["chatgpt", "openai-api"],
      models: [],
      reasoning_efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      supports_fast: true,
    };
    try {
      const text = readFileSync(join(homes.codex, "config.toml"), "utf8");
      codex.model = /^model\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
      codex.model_provider =
        /^model_provider\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
      if (codex.model) codex.models = [codex.model];
    } catch {}
    const pi: any = {
      model: null,
      model_provider: null,
      provider_choice: null,
      provider_choices: [
        "anthropic",
        "openai",
        "google",
        "openrouter",
        "deepseek",
      ],
      models: [],
      provider_models: {},
      reasoning_efforts: [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
      supports_fast: false,
    };
    try {
      const settings = JSON.parse(
        readFileSync(join(homes.pi, "settings.json"), "utf8"),
      );
      pi.model = settings.defaultModel ?? null;
      pi.model_provider = settings.defaultProvider ?? null;
      pi.provider_choice = pi.model_provider;
    } catch {}
    try {
      const config = JSON.parse(
        readFileSync(join(homes.pi, "models.json"), "utf8"),
      );
      for (const [provider, value] of Object.entries(
        config.providers ?? {},
      ) as Array<[string, any]>) {
        pi.provider_models[provider] = (value.models ?? []).map(
          (m: any) => m.id,
        );
        pi.provider_choices.push(provider);
      }
    } catch {}
    return {
      default_backend: "pi",
      provider_launch: true,
      backends: {
        codex,
        pi,
        cc: {
          model: null,
          models: ["sonnet", "opus", "haiku"],
          provider_choices: ["__custom_api__"],
          reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "auto"],
          supports_fast: true,
        },
      },
    };
  }
  async execute(operation: Operation): Promise<unknown> {
    if (operation.op === "workspace")
      return { id: "default", path: this.workspace };
    if (operation.op === "discover") return this.catalogue();
    if (operation.op === "resume-candidates")
      return this.request(
        `/api/session_resume_candidates?agent_backend=${operation.backend}&cwd=${encodeURIComponent(operation.cwd)}`,
      );
    if (operation.op === "create") {
      if (operation.backend === "fixture")
        throw new DomainError(
          400,
          "not_dispatched",
          "Fixture backend is disabled",
        );
      return this.launch(operation.backend, operation.name, operation.launch);
    }
    if (operation.op === "launch-status")
      throw Error("Launch status belongs to the Computer launch journal");
    if (operation.op === "send")
      return this.request(`/api/sessions/${operation.localId}/send`, "POST", {
        text: operation.text,
      });
    if (operation.op === "interrupt")
      return this.control(operation.localId, "interrupt");
    const meta = this.metadata(operation.localId);
    return {
      messages: readTranscript(meta.log_path, meta.agent_backend).events.map(
        (event) => ({
          id: event.message_id,
          role: event.role,
          text: event.text,
          at: event.ts * 1000,
        }),
      ),
    };
  }
  async completions(since: number): Promise<Notification[]> {
    return this.listMetadata().flatMap((meta) =>
      readTranscript(meta.log_path, meta.agent_backend)
        .events.filter(
          (event) =>
            event.role === "assistant" &&
            ["final_response", "error"].includes(event.message_class ?? "") &&
            event.ts * 1000 >= since,
        )
        .map((event) => ({
          id: createHash("sha256")
            .update(meta.session_id + event.message_id)
            .digest("hex"),
          localId: meta.session_id,
          kind:
            event.message_class === "error"
              ? ("attention" as const)
              : ("completion" as const),
          occurredAt: event.ts * 1000,
        })),
    );
  }
  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    const url = new URL(path, "http://native.invalid");
    const pathname = url.pathname;
    if (pathname === "/api/sessions") {
      if (method === "GET" || method === "HEAD") return this.catalogue();
      if (method === "POST") {
        const value = body as any;
        const { agent_backend, name, ...launch } = value ?? {};
        if (!["codex", "pi", "cc"].includes(agent_backend))
          throw new DomainError(
            400,
            "not_dispatched",
            "Choose a supported runtime",
          );
        const result = await this.launch(agent_backend, name ?? "", launch);
        return { broker_pid: result.brokerPid, session_id: result.localId };
      }
    }
    if (pathname === "/api/session_resume_candidates") {
      const backend = (url.searchParams.get("agent_backend") ??
        url.searchParams.get("backend") ??
        "codex") as Backend;
      if (!["codex", "pi", "cc"].includes(backend))
        throw new DomainError(
          400,
          "invalid_backend",
          "Choose a supported runtime",
        );
      const cwd = url.searchParams.get("cwd") ?? this.workspace;
      if (!isAbsolute(cwd))
        throw new DomainError(
          400,
          "invalid_cwd",
          "Working directory must be absolute",
        );
      return {
        ok: true,
        cwd,
        exists: existsSync(cwd),
        sessions: scanLogs(this.home, backend)
          .filter((log) => log.cwd === resolve(cwd))
          .slice(0, 100)
          .map((log) => ({
            session_id: log.id,
            cwd: log.cwd,
            updated_ts: log.updated / 1000,
            agent_backend: backend,
            alias: "",
            first_user_message:
              readTranscript(log.path, backend)
                .events.find((e) => e.role === "user")
                ?.text.slice(0, 160) ?? "",
          })),
      };
    }
    const match = /^\/api\/sessions\/(broker-[a-f0-9]{32})(?:\/(.*))?$/.exec(
      pathname,
    );
    if (!match)
      throw new DomainError(
        404,
        "unsupported_route",
        "Unsupported native runtime route",
      );
    const id = match[1]!,
      action = match[2] ?? "";
    const meta = this.metadata(id);
    const value = (body ?? {}) as Record<string, unknown>;
    if (action === "edit" && method === "POST")
      return new NativeSidebar(this.directory).edit(
        id,
        value,
        new Set(this.listMetadata().map((meta) => meta.session_id)),
      );
    if (action === "rename" && method === "POST") {
      if (typeof value.name !== "string")
        throw new DomainError(400, "invalid_sidebar", "name required");
      return new NativeSidebar(this.directory).rename(id, value.name);
    }
    if ((method === "DELETE" && !action) || action === "delete")
      return this.control(id, "delete");
    if (
      action === "messages/tail" ||
      action === "messages/history" ||
      action === "messages/window" ||
      action === "messages/live" ||
      action === "messages/export" ||
      action === "search"
    ) {
      const logRevision = meta.log_path
        ? createHash("sha256").update(meta.log_path).digest("hex").slice(0, 24)
        : id;
      const incomingCursor =
        (action === "messages/live" ? url.searchParams.get("after") : null) ??
        url.searchParams.get("cursor") ??
        "";
      if (incomingCursor && !incomingCursor.startsWith(id + ":"))
        throw new DomainError(
          409,
          "invalid_cursor",
          "This cursor belongs to a different session",
        );
      const rawAfter = incomingCursor.includes(":live:")
        ? incomingCursor.split(":")[2] === logRevision
          ? Number(incomingCursor.split(":").at(-1))
          : 0
        : 0;
      const transcript = readTranscript(
        meta.log_path,
        meta.agent_backend,
        action === "messages/live" ? rawAfter : 0,
      );
      const all = transcript.events;
      const limit = Math.max(
        1,
        Math.min(2000, Number(url.searchParams.get("limit") ?? 80)),
      );
      const cursor = (
        (action === "messages/live" ? url.searchParams.get("after") : null) ??
        url.searchParams.get("cursor") ??
        url.searchParams.get("before") ??
        ""
      )
        .split(":")
        .at(-1);
      let before =
        action === "messages/live"
          ? all.length
          : cursor
            ? Number(cursor)
            : all.length;
      if (!Number.isFinite(before) || before < 0)
        throw new DomainError(
          400,
          "invalid_cursor",
          "Invalid transcript cursor",
        );
      before = Math.min(before, all.length);
      let start = Math.max(0, before - limit),
        end = before;
      if (action === "messages/live") {
        start = incomingCursor.includes(":live:")
          ? all.findIndex((e) => e.history_cursor === incomingCursor)
          : cursor
            ? Math.min(Number(cursor), all.length)
            : 0;
        const eventAfter =
          incomingCursor.split(":")[2] === logRevision
            ? Number(incomingCursor.split(":")[3] ?? 0)
            : 0;
        start = incomingCursor.includes(":live:")
          ? Math.min(eventAfter, all.length)
          : Math.max(0, start);
        end = all.length;
      }
      if (action === "messages/window") {
        const position = Number(
          (url.searchParams.get("cursor") ?? "").split(":").at(-1),
        );
        if (!Number.isInteger(position))
          throw new DomainError(
            400,
            "invalid_cursor",
            "A history cursor is required",
          );
        start = Math.max(
          0,
          position -
            Math.min(100, Number(url.searchParams.get("before") ?? 30)),
        );
        end = Math.min(
          all.length,
          position +
            1 +
            Math.min(100, Number(url.searchParams.get("after") ?? 30)),
        );
      }
      if (action === "messages/export") {
        start = 0;
        end = all.length;
      }
      let events = all.slice(start, end).map((event, index) => ({
        ...event,
        history_cursor: `${id}:${start + index}`,
      }));
      let searchTotal = 0;
      if (action === "search") {
        const query = (
          url.searchParams.get("q") ??
          url.searchParams.get("query") ??
          ""
        ).toLowerCase();
        const found = all.filter((e) => e.text.toLowerCase().includes(query));
        searchTotal = found.length;
        const filtered = found.filter(
          (e) => !url.searchParams.has("before") || all.indexOf(e) < before,
        );
        events = filtered.slice(-limit).map((e) => ({
          ...e,
          history_cursor: `${id}:${all.indexOf(e)}`,
          before_byte: `${id}:${all.indexOf(e)}`,
        }));
      }
      let state: any = {};
      try {
        state = await this.control(id, "state");
      } catch {}
      return {
        events,
        matches: action === "search" ? events : undefined,
        total: action === "search" ? searchTotal : undefined,
        match_count: action === "search" ? searchTotal : undefined,
        truncated: false,
        event_count: events.length,
        transcript_state: meta.log_path
          ? "bound"
          : meta.readiness === "exited"
            ? "failed"
            : "pending_bind",
        log_path: meta.log_path ? `native:${id}:${logRevision}` : null,
        meta_delta:
          action === "messages/live"
            ? transcript.delta
            : { thinking: 0, thinking_tokens: 0, tool: 0, system: 0 },
        turn_start: transcript.boundaries.includes("start"),
        turn_end: transcript.boundaries.includes("end"),
        turn_aborted: transcript.boundaries.includes("aborted"),
        turn_boundaries: transcript.boundaries,
        live_cursor: `${id}:live:${logRevision}:${end}:${transcript.rows}`,
        history_cursor: start > 0 ? `${id}:${start}` : null,
        has_older: start > 0,
        has_newer: end < all.length,
        jumped_window: action === "messages/window",
        busy: state.busy ?? false,
        queue_len: state.queue?.length ?? 0,
        token: state.token ?? transcript.token,
        transcript_id: meta.thread_id ?? id,
        transcript_revision: meta.log_path
          ? createHash("sha256")
              .update(meta.log_path)
              .digest("hex")
              .slice(0, 24)
          : id,
        thread_id: meta.thread_id ?? id,
      };
    }
    if (action === "unread" || action === "read") {
      const events = readTranscript(meta.log_path, meta.agent_backend).events;
      let state: any;
      try {
        state = await this.control(id, "state");
      } catch {
        try {
          state = JSON.parse(
            readFileSync(join(this.directory, id + ".state.json"), "utf8"),
          );
        } catch {
          state = {};
        }
      }
      const markRead = async (eventId: string | null) => {
        try {
          return await this.control(id, "read", { event_id: eventId });
        } catch (error) {
          if (meta.readiness !== "exited") throw error;
          state.read_event_id = eventId;
          writeFileSync(
            join(this.directory, id + ".state.json"),
            JSON.stringify(state),
            { mode: 0o600 },
          );
          return { ok: true, event_id: eventId };
        }
      };
      const latest = events.at(-1)?.message_id ?? null;
      if (action === "read") {
        const eventId = (body as any)?.event_id ?? latest;
        if (eventId && !events.some((e) => e.message_id === eventId))
          throw new DomainError(
            400,
            "invalid_event_id",
            "Unknown transcript event",
          );
        return markRead(eventId);
      }
      if (!state.read_event_id) {
        await markRead(latest);
        return {
          count: 0,
          unread: 0,
          first_unread_event_id: null,
          last_unread_event_id: null,
        };
      }
      const index = events.findIndex(
        (e) => e.message_id === state.read_event_id,
      );
      const unread = events.slice(index + 1);
      return {
        count: unread.length,
        unread: unread.length,
        first_unread_event_id: unread[0]?.message_id ?? null,
        last_unread_event_id: unread.at(-1)?.message_id ?? null,
      };
    }
    if (action === "diagnostics") return { runtime: "native", session: meta };
    if (
      [
        "state",
        "tail",
        "send",
        "interrupt",
        "rename",
        "draft",
        "queue",
        "enqueue",
        "queue/delete",
        "queue/update",
        "queue/move",
        "attachments",
        "attachments/delete",
        "attachments/clear",
        "pending_attachment/clear",
        "inject_file",
        "inject_image",
        "unattended",
        "settings",
        "edit",
        "read",
        "commit_unknown_send/clear",
      ].includes(action)
    )
      return this.control(id, action, value);
    if (!action && method === "GET") return meta;
    throw new DomainError(
      404,
      "unsupported_route",
      `Unsupported native session route: ${action}`,
    );
  }
}
