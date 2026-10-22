// Throwaway spike. A scripted OpenAI-compatible chat-completions server on 127.0.0.1, so the Kimi CLI's
// own approval machinery can be exercised without a model entitlement. It is deterministic:
//   - a user turn asking for hello.txt and no tool result yet -> one tool call to the CLI's write tool
//   - the last message is a tool result                       -> "Done."
//   - the follow-up question                                  -> "hello.txt" only if the earlier write
//     tool call is present in the history the CLI sent (that is what proves the resume kept history)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Trace } from "./log.ts";

export type FakeModel = { url: string; requests: number; close(): Promise<void> };

const WRITE_NAMES = ["Write", "WriteFile", "write_file", "write"];

/** target: absolute path the scripted write tool call names. */
export async function startFakeModel(trace: Trace, target: string): Promise<FakeModel> {
  const state = { requests: 0, toolCallSeq: 0 };
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    state.requests += 1;
    let json: any = {};
    try {
      json = JSON.parse(body || "{}");
    } catch {
      /* not JSON */
    }
    const toolNames: string[] = (json.tools ?? []).map((t: any) => t.function?.name ?? t.name).filter(Boolean);
    trace.write("kimi->model", { method: req.method, url: req.url, stream: json.stream, model: json.model, toolNames, messages: summarize(json.messages) });
    if (req.method === "GET" && req.url?.endsWith("/models")) return sendJson(res, { object: "list", data: [{ id: "fake-coder", object: "model" }] });
    if (!req.url?.endsWith("/chat/completions")) return sendJson(res, { error: { message: `fake model: unknown path ${req.url}` } }, 404);

    const reply = decide(json, toolNames, state, target);
    trace.write("model->kimi", reply);
    if (json.stream) return sendStream(res, reply, json.model);
    return sendJson(res, completion(reply, json.model));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return state.requests;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

type Reply = { text?: string; toolCall?: { id: string; name: string; arguments: string } };

function decide(json: any, toolNames: string[], state: { toolCallSeq: number }, target: string): Reply {
  const messages: any[] = json.messages ?? [];
  const last = messages[messages.length - 1] ?? {};
  // The CLI appends its own <system-reminder> user messages; the real request is the last other one.
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && !textOf(m.content).trimStart().startsWith("<system-reminder>"));
  const userText = textOf(lastUser?.content);
  if (last.role === "tool") return { text: "Done." };
  if (/what is the exact name of the file/i.test(userText)) {
    const wroteHello = messages.some((m) => (m.tool_calls ?? []).some((c: any) => /hello\.txt/.test(c.function?.arguments ?? "")));
    return { text: wroteHello ? "hello.txt" : "I have not created any file in this conversation." };
  }
  if (/hello\.txt/.test(userText)) {
    const name = WRITE_NAMES.find((n) => toolNames.includes(n)) ?? toolNames.find((n) => /write/i.test(n));
    if (!name) return { text: `fake model: no write tool offered (tools: ${toolNames.join(",")})` };
    const params = toolParams(json.tools, name);
    const pathKey = ["file_path", "path", "filePath"].find((k) => k in params) ?? "file_path";
    const contentKey = ["content", "text", "contents"].find((k) => k in params) ?? "content";
    state.toolCallSeq += 1;
    return { toolCall: { id: `call_fake_${state.toolCallSeq}`, name, arguments: JSON.stringify({ [pathKey]: target, [contentKey]: "hello" }) } };
  }
  return { text: "ok" };
}

function toolParams(tools: any[] = [], name: string): Record<string, unknown> {
  const t = tools.find((x) => (x.function?.name ?? x.name) === name);
  return (t?.function?.parameters ?? t?.parameters ?? t?.input_schema ?? {}).properties ?? {};
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? "").join("\n");
  return "";
}

function summarize(messages: any[] = []): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    text: textOf(m.content).slice(0, 160),
    tool_calls: (m.tool_calls ?? []).map((c: any) => `${c.function?.name}(${(c.function?.arguments ?? "").slice(0, 120)})`),
    tool_call_id: m.tool_call_id,
  }));
}

function completion(reply: Reply, model: string) {
  const message: any = { role: "assistant", content: reply.text ?? null };
  if (reply.toolCall) message.tool_calls = [{ id: reply.toolCall.id, type: "function", function: { name: reply.toolCall.name, arguments: reply.toolCall.arguments } }];
  return {
    id: `chatcmpl_fake_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: reply.toolCall ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function sendStream(res: ServerResponse, reply: Reply, model: string): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const base = { id: `chatcmpl_fake_${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
  chunk({ role: "assistant", content: "" });
  if (reply.text) chunk({ content: reply.text });
  if (reply.toolCall) {
    chunk({ tool_calls: [{ index: 0, id: reply.toolCall.id, type: "function", function: { name: reply.toolCall.name, arguments: "" } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: reply.toolCall.arguments } }] });
  }
  chunk({}, reply.toolCall ? "tool_calls" : "stop", { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.write("data: [DONE]\n\n");
  res.end();
}

function sendJson(res: ServerResponse, obj: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => r(s));
  });
}
