import type { Plugin } from "@opencode-ai/plugin";

/**
 * Engram Plugin for OpenCode
 *
 * Provides automatic memory extraction and recall:
 * - On session.idle (debounced): Extracts and persists learnings via HTTP
 * - On compaction: Injects recall instruction for context continuity
 *
 * Memory extraction happens via HTTP to the Engram daemon, which is
 * auto-started if not running. No child sessions, no chat pollution.
 */

const DEBOUNCE_MS = 60_000; // 60 seconds
const MAX_MESSAGES_FOR_CONTEXT = 20; // Last N messages to extract from
const ENGRAM_URL = "http://127.0.0.1:7749";

export const EngramPlugin: Plugin = async ({ client, $ }) => {
  // Track last extraction time per session for debouncing
  const lastExtraction: Record<string, number> = {};

  /**
   * Ensure the Engram daemon is running, start it if not.
   * Returns true if daemon is ready, false if failed to start.
   */
  async function ensureDaemonRunning(): Promise<boolean> {
    try {
      const health = await fetch(`${ENGRAM_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return health.ok;
    } catch {
      // Daemon not running, try to start it
      await client.app.log({
        body: {
          service: "engram-plugin",
          level: "info",
          message: "Engram daemon not running, starting...",
        },
      });

      try {
        // Start the daemon
        await $`engram start`.quiet();

        // Wait for it to be ready
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // Verify it started
        const health = await fetch(`${ENGRAM_URL}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return health.ok;
      } catch (startError) {
        await client.app.log({
          body: {
            service: "engram-plugin",
            level: "warn",
            message: `Failed to start engram daemon: ${startError}`,
          },
        });
        return false;
      }
    }
  }

  /**
   * Extract memories by calling the Engram HTTP API.
   * Auto-starts daemon if not running.
   */
  async function extractMemories(
    sessionId: string,
    trigger: "idle" | "compaction",
  ): Promise<void> {
    try {
      // Ensure daemon is running
      const daemonReady = await ensureDaemonRunning();
      if (!daemonReady) {
        await client.app.log({
          body: {
            service: "engram-plugin",
            level: "warn",
            message: "Engram daemon not available, skipping extraction",
          },
        });
        return;
      }

      // Fetch recent messages from the session
      const messagesResponse = await client.session.messages({
        path: { id: sessionId },
      });

      if (!messagesResponse.data || messagesResponse.data.length === 0) {
        return; // No messages to extract from
      }

      // Take the last N messages and format them as context
      const recentMessages = messagesResponse.data.slice(
        -MAX_MESSAGES_FOR_CONTEXT,
      );
      const contextSummary = recentMessages
        .map((msg) => {
          const role = msg.info.role === "user" ? "User" : "Assistant";
          const textParts = msg.parts
            .filter((p) => p.type === "text")
            .map((p) => (p as { type: "text"; text: string }).text)
            .join("\n");
          return `[${role}]: ${textParts.slice(0, 2000)}`; // Truncate long messages
        })
        .join("\n\n---\n\n");

      // Skip if context is too short to be meaningful
      if (contextSummary.length < 100) {
        return;
      }

      // Call the HTTP API
      const response = await fetch(`${ENGRAM_URL}/remember`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `Session context (trigger: ${trigger}):\n\n${contextSummary}`,
          category: "insight",
          session_id: sessionId,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      await client.app.log({
        body: {
          service: "engram-plugin",
          level: "info",
          message: `Memory extracted (trigger: ${trigger}, session: ${sessionId})`,
        },
      });
    } catch (error) {
      // Log but don't fail - extraction is best-effort
      await client.app.log({
        body: {
          service: "engram-plugin",
          level: "warn",
          message: `Memory extraction failed: ${error}`,
        },
      });
    }
  }

  return {
    /**
     * Before compaction: extract memories + inject recall instruction
     */
    "experimental.session.compacting": async (input, output) => {
      // Trigger extraction in background (don't await - let compaction proceed)
      const sessionId = input.session?.id;
      if (sessionId) {
        extractMemories(sessionId, "compaction").catch(() => {
          // Already logged in extractMemories
        });
      }

      // Inject recall instruction into the compacted session
      output.context.push(
        `## Memory Continuity
Before continuing, use engram_recall to retrieve relevant memories that may help maintain context across this compaction. Pass the current task or project context as the query.`,
      );
    },

    /**
     * On session idle: trigger memory extraction
     * Debounced to avoid excessive extraction calls
     */
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionId = event.properties.sessionID;
        const now = Date.now();

        // Debounce: skip if extracted recently
        if (
          lastExtraction[sessionId] &&
          now - lastExtraction[sessionId] < DEBOUNCE_MS
        ) {
          return;
        }

        lastExtraction[sessionId] = now;

        // Trigger extraction (fire and forget)
        extractMemories(sessionId, "idle").catch(() => {
          // Already logged in extractMemories
        });
      }
    },
  };
};

export default EngramPlugin;
