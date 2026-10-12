/**
 * opencode-session-bus — validated session-to-session messaging for OpenCode.
 *
 * OpenCode already durably admits session prompts. This plugin adds the two
 * things the native API cannot: a validated destination for a send, and a reply
 * path that resolves its destination from a stored request instead of trusting
 * an id typed into a message body.
 *
 * The runtime does not resolve @opencode/plugin, so this file exports a plain
 * { id, setup } object and has no runtime dependencies.
 */

import { randomBytes } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

export interface BusRequest {
  id: string
  fromSessionId: string
  toSessionId: string
  createdAt: number
  status: "admitted" | "replied"
  replyMessageId?: string
  repliedAt?: number
}

/** Structural subset of `ctx.storage` used by the ledger. */
export interface LedgerStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

interface ToolResult {
  content: string
}

interface ToolDefinition {
  name: string
  description: string
  input: unknown
  execute(input: unknown, context: { sessionID?: string }): Promise<ToolResult>
}

interface ToolEditor {
  add(tool: ToolDefinition): void
}

interface SessionInfo {
  id: string
  title?: string
  location?: { directory?: string }
  model?: unknown
  agent?: unknown
}

/** Structural subset of the plugin context this plugin uses. */
export interface SessionBusContext {
  storage: LedgerStorage
  tool: {
    transform(apply: (editor: ToolEditor) => void): Promise<{ dispose(): Promise<void> }>
  }
  session: {
    get(input: { sessionID: string }): Promise<SessionInfo>
    create(input: {
      title?: string
      location: { directory: string }
      agent?: string
      model?: { providerID: string; id: string }
    }): Promise<SessionInfo>
    prompt(input: {
      sessionID: string
      text: string
      delivery?: "steer" | "queue"
      resume?: boolean
      metadata?: Record<string, unknown>
    }): Promise<{ id?: string } | undefined>
  }
}

const KEY_PREFIX = "session-bus/request/"
const requestKey = (id: string): string => `${KEY_PREFIX}${id}`

export function newRequestId(): string {
  return randomBytes(8).toString("hex")
}

export function createLedger(storage: LedgerStorage) {
  async function get(id: string): Promise<BusRequest | undefined> {
    const value = await storage.get(requestKey(id))
    return value ? (value as BusRequest) : undefined
  }

  async function put(record: BusRequest): Promise<void> {
    await storage.set(requestKey(record.id), record)
  }

  async function markReplied(id: string, replyMessageId: string, at: number): Promise<void> {
    const record = await get(id)
    if (!record) return
    await storage.set(requestKey(id), {
      ...record,
      status: "replied",
      replyMessageId,
      repliedAt: at,
    })
  }

  return { get, put, markReplied }
}

/**
 * Resolve the directory a new session should open in. An omitted request keeps
 * the caller's directory; a relative request resolves against it. The result is
 * a real path that already exists; this never creates a directory.
 */
export function resolveTargetDirectory(callerDirectory: string, requested?: string): string {
  const candidate =
    requested && requested.trim()
      ? isAbsolute(requested)
        ? requested
        : resolve(callerDirectory, requested)
      : callerDirectory
  let real: string
  try {
    real = realpathSync(candidate)
  } catch {
    throw new Error(`directory does not exist: ${candidate}`)
  }
  if (!statSync(real).isDirectory()) throw new Error(`not a directory: ${real}`)
  return real
}

/**
 * Resolve the destination a reply must go to, and reject any caller that is not
 * the session the request was addressed to. This is what stops a session from
 * replying as someone else.
 */
export function replyTargetFor(record: BusRequest, callerSessionId: string): string {
  if (record.toSessionId !== callerSessionId) {
    throw new Error(`request ${record.id} was not addressed to session ${callerSessionId}`)
  }
  return record.fromSessionId
}

export function frameOutbound(requestId: string, fromSessionId: string, text: string): string {
  return [
    `[session-bus request ${requestId}]`,
    `from: ${fromSessionId}`,
    `Reply with the session_reply tool and request_id "${requestId}". Do not address a session id yourself.`,
    "",
    text,
  ].join("\n")
}

export function frameReply(requestId: string, fromSessionId: string, text: string): string {
  return [`[session-bus reply ${requestId}]`, `from: ${fromSessionId}`, "", text].join("\n")
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const SEND_INPUT = {
  type: "object",
  properties: {
    session_id: { type: "string", description: "Exact target session id (never guessed)" },
    text: { type: "string", description: "Plain-text message body" },
    delivery: {
      type: "string",
      enum: ["steer", "queue"],
      description: "How the target admits the message; defaults to queue",
    },
  },
  required: ["session_id", "text"],
  additionalProperties: false,
}

const CREATE_INPUT = {
  type: "object",
  properties: {
    title: { type: "string" },
    directory: {
      type: "string",
      description: "Target directory; omit to use the calling session's directory",
    },
    allow_cross_directory: {
      type: "boolean",
      description: "Set true only after the user approved creating outside the calling directory",
    },
    agent: { type: "string" },
    model: {
      type: "object",
      properties: { providerID: { type: "string" }, id: { type: "string" } },
      required: ["providerID", "id"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

const REPLY_INPUT = {
  type: "object",
  properties: {
    request_id: {
      type: "string",
      description: "Request id from a received session-bus request",
    },
    text: { type: "string" },
  },
  required: ["request_id", "text"],
  additionalProperties: false,
}

const STATUS_INPUT = {
  type: "object",
  properties: { request_id: { type: "string" } },
  required: ["request_id"],
  additionalProperties: false,
}

export const sessionBusPlugin = {
  id: "opencode2-session-connector",
  async setup(ctx: SessionBusContext): Promise<() => Promise<void>> {
    const ledger = createLedger(ctx.storage)

    async function callerDirectory(sessionID: string | undefined): Promise<string> {
      if (!sessionID) throw new Error("no calling session in tool context")
      const session = await ctx.session.get({ sessionID })
      const directory = session?.location?.directory
      if (!directory) throw new Error(`cannot resolve directory for session ${sessionID}`)
      return directory
    }

    const registration = await ctx.tool.transform((editor) => {
      editor.add({
        name: "session_create",
        description:
          "Create a new opencode session and return its id. Omit directory to create it in the calling session's directory; a different directory must be explicit and approved by the user.",
        input: CREATE_INPUT,
        async execute(raw, tool): Promise<ToolResult> {
          const args = (raw ?? {}) as Record<string, unknown>
          try {
            const callerDir = await callerDirectory(tool.sessionID)
            const target = resolveTargetDirectory(callerDir, optionalString(args.directory))
            if (target !== callerDir && args.allow_cross_directory !== true) {
              return {
                content: `Error: "${target}" is outside the calling session's directory "${callerDir}". Confirm with the user, then retry with allow_cross_directory: true.`,
              }
            }
            const model =
              args.model && typeof args.model === "object"
                ? (args.model as { providerID: string; id: string })
                : undefined
            const agent = optionalString(args.agent)
            const created = await ctx.session.create({
              title: optionalString(args.title),
              location: { directory: target },
              ...(agent ? { agent } : {}),
              ...(model ? { model } : {}),
            })
            return {
              content: JSON.stringify(
                {
                  session_id: created.id,
                  title: created.title ?? null,
                  directory: created.location?.directory ?? target,
                  model: created.model ?? null,
                  agent: created.agent ?? null,
                },
                null,
                2,
              ),
            }
          } catch (error) {
            return { content: `Error: ${errorMessage(error)}` }
          }
        },
      })

      editor.add({
        name: "session_send",
        description:
          "Send a plain-text message to an exact opencode session id and return a request_id. The caller must supply a real id (from session_create or the user); this tool never guesses a destination.",
        input: SEND_INPUT,
        async execute(raw, tool): Promise<ToolResult> {
          const args = (raw ?? {}) as Record<string, unknown>
          const sessionID = nonEmptyString(args.session_id)
          const text = nonEmptyString(args.text)
          if (!sessionID || !text) {
            return { content: "Error: session_id and text are required." }
          }
          const delivery = args.delivery === "steer" || args.delivery === "queue" ? args.delivery : "queue"
          try {
            const caller = tool.sessionID
            if (!caller) return { content: "Error: no calling session in tool context." }
            if (sessionID === caller) {
              return { content: "Error: cannot send to the calling session." }
            }
            const target = await ctx.session.get({ sessionID })
            const id = newRequestId()
            await ledger.put({
              id,
              fromSessionId: caller,
              toSessionId: target.id,
              createdAt: Date.now(),
              status: "admitted",
            })
            const admitted = await ctx.session.prompt({
              sessionID: target.id,
              text: frameOutbound(id, caller, text),
              delivery,
              resume: true,
              metadata: { sessionBus: { requestId: id, fromSessionId: caller } },
            })
            return {
              content: JSON.stringify(
                {
                  request_id: id,
                  to: {
                    session_id: target.id,
                    title: target.title ?? null,
                    directory: target.location?.directory ?? null,
                  },
                  admitted: true,
                  message_id: admitted?.id ?? null,
                },
                null,
                2,
              ),
            }
          } catch (error) {
            return { content: `Error: ${errorMessage(error)}` }
          }
        },
      })

      editor.add({
        name: "session_reply",
        description:
          "Reply to a session-bus request. The destination is resolved from the stored request, so no session id is accepted here; only the session the request was addressed to may reply.",
        input: REPLY_INPUT,
        async execute(raw, tool): Promise<ToolResult> {
          const args = (raw ?? {}) as Record<string, unknown>
          const requestID = nonEmptyString(args.request_id)
          const text = nonEmptyString(args.text)
          if (!requestID || !text) {
            return { content: "Error: request_id and text are required." }
          }
          try {
            const caller = tool.sessionID
            if (!caller) return { content: "Error: no calling session in tool context." }
            const record = await ledger.get(requestID)
            if (!record) return { content: `Error: unknown request_id "${requestID}".` }
            const destination = replyTargetFor(record, caller)
            const admitted = await ctx.session.prompt({
              sessionID: destination,
              text: frameReply(record.id, caller, text),
              delivery: "queue",
              resume: true,
              metadata: { sessionBus: { replyTo: record.id, fromSessionId: caller } },
            })
            await ledger.markReplied(record.id, admitted?.id ?? "", Date.now())
            return {
              content: JSON.stringify(
                {
                  request_id: record.id,
                  delivered_to: destination,
                  message_id: admitted?.id ?? null,
                },
                null,
                2,
              ),
            }
          } catch (error) {
            return { content: `Error: ${errorMessage(error)}` }
          }
        },
      })

      editor.add({
        name: "session_message_status",
        description:
          "Report the durable status of a session-bus request this session sent or received. Visible only to the two participant sessions.",
        input: STATUS_INPUT,
        async execute(raw, tool): Promise<ToolResult> {
          const args = (raw ?? {}) as Record<string, unknown>
          const requestID = nonEmptyString(args.request_id)
          if (!requestID) return { content: "Error: request_id is required." }
          try {
            const caller = tool.sessionID
            const record = await ledger.get(requestID)
            if (!record) return { content: `Error: unknown request_id "${requestID}".` }
            if (record.fromSessionId !== caller && record.toSessionId !== caller) {
              return { content: "Error: this session is not a participant in that request." }
            }
            return {
              content: JSON.stringify(
                {
                  request_id: record.id,
                  from_session_id: record.fromSessionId,
                  to_session_id: record.toSessionId,
                  status: record.status,
                  created_at: record.createdAt,
                  reply_message_id: record.replyMessageId ?? null,
                  replied_at: record.repliedAt ?? null,
                },
                null,
                2,
              ),
            }
          } catch (error) {
            return { content: `Error: ${errorMessage(error)}` }
          }
        },
      })
    })

    return async () => {
      await registration.dispose()
    }
  },
}

export default sessionBusPlugin
