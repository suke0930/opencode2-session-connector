import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, {
  createLedger,
  frameOutbound,
  frameReply,
  newRequestId,
  replyTargetFor,
  resolveTargetDirectory,
} from "../index.ts"

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    async get(key) {
      return data.get(key)
    },
    async set(key, value) {
      data.set(key, value)
    },
  }
}

async function makeHarness({ sessions, caller = "ses_caller" } = {}) {
  const storage = makeStorage()
  const tools = {}
  const prompts = []
  const creates = []
  const known = new Map(Object.entries(sessions ?? {}))
  const ctx = {
    storage,
    tool: {
      transform: async (apply) => {
        apply({
          add: (tool) => {
            tools[tool.name] = tool
          },
        })
        return { dispose: async () => {} }
      },
    },
    session: {
      async get({ sessionID }) {
        const session = known.get(sessionID)
        if (!session) throw new Error(`session not found: ${sessionID}`)
        return session
      },
      async create(input) {
        const created = {
          id: `ses_new_${creates.length}`,
          title: input.title ?? "new",
          location: { directory: input.location.directory },
          model: input.model ?? null,
          agent: input.agent ?? null,
        }
        creates.push(input)
        return created
      },
      async prompt(input) {
        prompts.push(input)
        return { id: `msg_${prompts.length}` }
      },
    },
  }
  await plugin.setup(ctx)
  const run = (name, raw, as = caller) => tools[name].execute(raw, { sessionID: as })
  return { storage, tools, prompts, creates, run }
}

function session(id, directory, title = id) {
  return { id, title, location: { directory }, time: { created: 1, updated: 1 } }
}

test("ledger stores and updates a request", async () => {
  const ledger = createLedger(makeStorage())
  const id = newRequestId()
  await ledger.put({ id, fromSessionId: "a", toSessionId: "b", createdAt: 1, status: "admitted" })
  assert.equal((await ledger.get(id)).status, "admitted")
  await ledger.markReplied(id, "msg_1", 2)
  const updated = await ledger.get(id)
  assert.equal(updated.status, "replied")
  assert.equal(updated.replyMessageId, "msg_1")
  assert.equal(await ledger.get("missing"), undefined)
})

test("replyTargetFor rejects a session the request was not addressed to", () => {
  const record = { id: "r1", fromSessionId: "a", toSessionId: "b", createdAt: 1, status: "admitted" }
  assert.equal(replyTargetFor(record, "b"), "a")
  assert.throws(() => replyTargetFor(record, "c"), /not addressed/)
  assert.throws(() => replyTargetFor(record, "a"), /not addressed/)
})

test("resolveTargetDirectory resolves existing directories and rejects missing ones", () => {
  const root = mkdtempSync(join(tmpdir(), "session-bus-"))
  try {
    mkdirSync(join(root, "sub"))
    assert.equal(resolveTargetDirectory(root), realpathSync(root))
    assert.equal(resolveTargetDirectory(root, "."), realpathSync(root))
    assert.equal(resolveTargetDirectory(root, "sub"), realpathSync(join(root, "sub")))
    assert.throws(() => resolveTargetDirectory(root, "nope"), /does not exist/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("frames carry the request id and sender", () => {
  assert.match(frameOutbound("r1", "ses_a", "hello"), /session-bus request r1/)
  assert.match(frameOutbound("r1", "ses_a", "hello"), /ses_a/)
  assert.match(frameReply("r1", "ses_b", "hi"), /session-bus reply r1/)
})

test("session_create defaults to the caller directory", async () => {
  const h = await makeHarness({ sessions: { ses_caller: session("ses_caller", "/tmp") } })
  const result = JSON.parse((await h.run("session_create", { title: "x" })).content)
  assert.equal(result.directory, "/tmp")
  assert.equal(h.creates[0].location.directory, "/tmp")
})

test("session_create blocks an unapproved cross-directory target", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-bus-"))
  const other = mkdtempSync(join(tmpdir(), "session-bus-other-"))
  try {
    const h = await makeHarness({ sessions: { ses_caller: session("ses_caller", root) } })
    const blocked = await h.run("session_create", { directory: other })
    assert.match(blocked.content, /outside the calling session/)
    assert.equal(h.creates.length, 0)

    const allowed = JSON.parse(
      (await h.run("session_create", { directory: other, allow_cross_directory: true })).content,
    )
    assert.equal(allowed.directory, realpathSync(other))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test("session_send validates the target and returns a request id", async () => {
  const h = await makeHarness({
    sessions: {
      ses_caller: session("ses_caller", "/tmp/a"),
      ses_target: session("ses_target", "/tmp/b", "target"),
    },
  })
  const result = JSON.parse((await h.run("session_send", { session_id: "ses_target", text: "hi" })).content)
  assert.equal(result.admitted, true)
  assert.equal(result.to.session_id, "ses_target")
  assert.equal(h.prompts.length, 1)
  assert.match(h.prompts[0].text, new RegExp(result.request_id))
  assert.equal(h.prompts[0].delivery, "queue")

  assert.match((await h.run("session_send", { session_id: "ses_caller", text: "hi" })).content, /calling session/)
  assert.match((await h.run("session_send", { session_id: "ses_missing", text: "hi" })).content, /Error/)
  assert.match((await h.run("session_send", { session_id: "ses_target", text: "" })).content, /required/)
  assert.equal(h.prompts.length, 1)
})

test("session_reply is refused from any session but the addressed one", async () => {
  const h = await makeHarness({
    sessions: {
      ses_caller: session("ses_caller", "/tmp/a"),
      ses_target: session("ses_target", "/tmp/b", "target"),
      ses_other: session("ses_other", "/tmp/c"),
    },
  })
  const sent = JSON.parse((await h.run("session_send", { session_id: "ses_target", text: "hi" })).content)

  const asSender = await h.run("session_reply", { request_id: sent.request_id, text: "x" }, "ses_caller")
  assert.match(asSender.content, /not addressed/)
  const asOther = await h.run("session_reply", { request_id: sent.request_id, text: "x" }, "ses_other")
  assert.match(asOther.content, /not addressed/)
  assert.equal(h.prompts.length, 1)

  const reply = JSON.parse(
    (await h.run("session_reply", { request_id: sent.request_id, text: "pong" }, "ses_target")).content,
  )
  assert.equal(reply.delivered_to, "ses_caller")
  assert.equal(h.prompts.length, 2)
  assert.equal(h.prompts[1].sessionID, "ses_caller")
  assert.match(h.prompts[1].text, /session-bus reply/)

  const status = JSON.parse((await h.run("session_message_status", { request_id: sent.request_id })).content)
  assert.equal(status.status, "replied")
  assert.equal(status.reply_message_id, reply.message_id)
})

test("a foreign plugin instance does not know the request id", async () => {
  const h = await makeHarness({
    sessions: {
      ses_caller: session("ses_caller", "/tmp/a"),
      ses_target: session("ses_target", "/tmp/b"),
    },
  })
  const sent = JSON.parse((await h.run("session_send", { session_id: "ses_target", text: "hi" })).content)
  const outsider = await makeHarness({
    sessions: { ses_other: session("ses_other", "/tmp/c") },
    caller: "ses_other",
  })
  assert.match(
    (await outsider.run("session_message_status", { request_id: sent.request_id })).content,
    /unknown request_id/,
  )
})
