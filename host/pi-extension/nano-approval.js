// Nano's approval extension for pi (Phase 5b ruling R3, ADR 0007). The host starts every pi
// session as `pi --mode rpc --no-extensions -e <this file>`, so this is the only extension that sees tool
// calls: none of the operator's own extensions can approve silently or change the tool set.
//
// Read-only tools run without a prompt. Every other tool call (bash, write, edit, and any tool pi or a
// package adds) asks first with `ctx.ui.confirm`. In RPC mode that is an `extension_ui_request` with
// method "confirm"; the host recognizes it by APPROVAL_TITLE, reads the call from the JSON message, maps it
// to an approval/request and answers with `extension_ui_response {confirmed}`. A refusal blocks the tool:
// pi reports the call as an error result and the model sees the reason.
//
// Plain JavaScript without imports: pi loads it with jiti, the host's tests import it directly.

/** Tools that only read: they run without asking. */
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

/** The confirm title that marks a dialog as a Nano approval (its message is the JSON of the call). */
export const APPROVAL_TITLE = 'nano-approval';

/** @param {any} pi the pi ExtensionAPI */
export default function nanoApproval(pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (READ_ONLY_TOOLS.includes(event.toolName)) return undefined;
    const reason = `${event.toolName} was not approved in Nano`;
    // Without a client to ask (a print-mode run) nothing that changes things may run.
    if (!ctx.hasUI) return { block: true, reason };
    const call = { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input ?? {}, cwd: ctx.cwd };
    if (event.parentToolCallId !== undefined) call.parentToolCallId = event.parentToolCallId;
    const approved = await ctx.ui.confirm(APPROVAL_TITLE, JSON.stringify(call));
    return approved ? undefined : { block: true, reason };
  });
}
