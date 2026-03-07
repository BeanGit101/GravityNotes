interface StartupDiagnosticEvent {
  at: string;
  name: string;
  detail?: string;
}

interface StartupDiagnosticSession {
  sessionId: string;
  startedAt: string;
  lastUpdatedAt: string;
  status: "running" | "ready" | "error";
  events: StartupDiagnosticEvent[];
}

type DiagnosticValue = boolean | number | string | null | undefined;
type DiagnosticDetail = Record<string, DiagnosticValue>;

const STARTUP_DIAGNOSTICS_KEY = "gravity.startupDiagnostics";
const MAX_STORED_SESSIONS = 10;

let currentSessionId: string | null = null;
let handlersInstalled = false;

function nowIso(): string {
  return new Date().toISOString();
}

function serializeDetail(detail?: DiagnosticDetail): string | undefined {
  if (!detail) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(detail)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value ?? null])
  );

  return Object.keys(normalized).length > 0 ? JSON.stringify(normalized) : undefined;
}

function isStartupDiagnosticSession(value: unknown): value is StartupDiagnosticSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const session = value as Record<string, unknown>;
  return (
    typeof session["sessionId"] === "string" &&
    typeof session["startedAt"] === "string" &&
    typeof session["lastUpdatedAt"] === "string" &&
    (session["status"] === "running" ||
      session["status"] === "ready" ||
      session["status"] === "error") &&
    Array.isArray(session["events"])
  );
}

function readSessions(): StartupDiagnosticSession[] {
  try {
    const raw = window.localStorage.getItem(STARTUP_DIAGNOSTICS_KEY);
    if (!raw) {
      return [];
    }

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isStartupDiagnosticSession);
  } catch {
    return [];
  }
}

function writeSessions(sessions: StartupDiagnosticSession[]): void {
  try {
    window.localStorage.setItem(
      STARTUP_DIAGNOSTICS_KEY,
      JSON.stringify(sessions.slice(0, MAX_STORED_SESSIONS))
    );
  } catch {
    // Diagnostics should never block app startup.
  }
}

function getBodyElement(): HTMLBodyElement | undefined {
  return document.getElementsByTagName("body")[0];
}

function setBootState(state: "booting" | "ready" | "error"): void {
  document.documentElement.dataset["gravityBoot"] = state;

  const body = getBodyElement();
  if (body) {
    body.dataset["gravityBoot"] = state;
  }
}

function updateCurrentSession(
  updater: (session: StartupDiagnosticSession) => StartupDiagnosticSession
): void {
  if (!currentSessionId) {
    return;
  }

  const sessions = readSessions();
  const index = sessions.findIndex((session) => session.sessionId === currentSessionId);
  if (index === -1) {
    return;
  }

  const session = sessions[index];
  if (!session) {
    return;
  }

  const updated = updater(session);
  sessions[index] = {
    ...updated,
    lastUpdatedAt: nowIso(),
  };
  writeSessions(sessions);
}

function appendEvent(
  session: StartupDiagnosticSession,
  name: string,
  detail?: DiagnosticDetail
): StartupDiagnosticSession {
  return {
    ...session,
    events: [
      ...session.events,
      {
        at: nowIso(),
        name,
        detail: serializeDetail(detail),
      },
    ],
  };
}

function createSessionId(): string {
  return typeof globalThis.crypto.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
}

export function beginStartupDiagnostics(detail?: DiagnosticDetail): void {
  const startedAt = nowIso();
  const sessionId = createSessionId();

  currentSessionId = sessionId;
  setBootState("booting");

  const session: StartupDiagnosticSession = {
    sessionId,
    startedAt,
    lastUpdatedAt: startedAt,
    status: "running",
    events: [],
  };

  writeSessions([session, ...readSessions()]);
  recordStartupEvent("boot.session.started", detail);
}

export function recordStartupEvent(name: string, detail?: DiagnosticDetail): void {
  updateCurrentSession((session) => appendEvent(session, name, detail));
}

export function markStartupReady(detail?: DiagnosticDetail): void {
  setBootState("ready");
  updateCurrentSession((session) => ({
    ...appendEvent(session, "boot.ui.ready", detail),
    status: session.status === "error" ? "error" : "ready",
  }));
}

export function markStartupError(name: string, detail?: DiagnosticDetail): void {
  setBootState("error");
  updateCurrentSession((session) => ({
    ...appendEvent(session, name, detail),
    status: "error",
  }));
}

export function installStartupErrorHandlers(): void {
  if (handlersInstalled) {
    return;
  }

  window.addEventListener("error", (event) => {
    markStartupError("boot.window.error", {
      column: event.colno,
      filename: event.filename,
      line: event.lineno,
      message: event.message,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason =
      typeof event.reason === "string"
        ? event.reason
        : event.reason instanceof Error
          ? event.reason.message
          : JSON.stringify(event.reason ?? null);

    markStartupError("boot.window.unhandledrejection", { reason });
  });

  handlersInstalled = true;
}

export function exposeStartupDiagnostics(): void {
  const diagnosticsWindow = window as Window & {
    __gravityGetStartupDiagnostics?: () => StartupDiagnosticSession[];
  };
  diagnosticsWindow.__gravityGetStartupDiagnostics = getStartupDiagnosticsHistory;
}

export function getStartupDiagnosticsHistory(): StartupDiagnosticSession[] {
  return readSessions();
}

export function resetStartupDiagnosticsForTests(): void {
  currentSessionId = null;
  try {
    window.localStorage.removeItem(STARTUP_DIAGNOSTICS_KEY);
  } catch {
    // Ignore storage reset errors in tests.
  }

  delete document.documentElement.dataset["gravityBoot"];

  const body = getBodyElement();
  if (body) {
    delete body.dataset["gravityBoot"];
  }
}
