#!/usr/bin/env python3
"""Check the Nano Remote protocol v1 schemas and examples.

Run from the repo root:  python3 -I protocol/verify.py
Exit 0 when everything passes; exit 1 and list every failure otherwise.
"""
import base64
import json
import re
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, SchemaError
from jsonschema.exceptions import best_match
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

HERE = Path(__file__).resolve().parent
SCHEMA_DIR = HERE / "schema"
EXAMPLE_DIR = HERE / "examples"
BASE = "https://nano-remote.dev/schema/v1/"
META = "https://json-schema.org/draft/2020-12/schema"
REQUIRED_SCHEMAS = ["envelope.json", "message.json", "common.json", "methods.json", "events.json"]
ENVELOPE = BASE + "envelope.json"
MESSAGE = BASE + "message.json"
AT_VALUES = ("params", "result", "error", "message")
MESSAGE_TYPES = ("client_message", "server_message")
CHUNK_TYPES = ("client_message_chunk", "server_message_chunk")
MAX_SEGMENT_BYTES = 100 * 1024
UUID = "7c1e4b2a-9d3f-4e8a-b1c6-2f5d8e0a9b71"

failures = []


def fail(where, text):
    failures.append(f"{where}: {text}")


def load_json(path, where):
    try:
        with path.open(encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        fail(where, f"cannot parse JSON: {exc}")
        return None


def first_error(validator, instance):
    err = best_match(validator.iter_errors(instance))
    if err is None:
        return None
    where = "/".join(str(p) for p in err.absolute_path) or "(root)"
    return f"{err.message} (at {where})"


def unescape_pointer(part):
    return part.replace("~1", "/").replace("~0", "~")


def build_registry():
    registry = Registry()
    docs = {}
    for name in REQUIRED_SCHEMAS:
        if not (SCHEMA_DIR / name).exists():
            fail(f"schema/{name}", "missing")
    for path in sorted(SCHEMA_DIR.glob("*.json")):
        where = f"schema/{path.name}"
        doc = load_json(path, where)
        if doc is None:
            continue
        uri = BASE + path.name
        if doc.get("$id") != uri:
            fail(where, f"$id must be {uri}")
        if doc.get("$schema") != META:
            fail(where, f"$schema must be {META}")
        try:
            Draft202012Validator.check_schema(doc)
        except SchemaError as exc:
            fail(where, f"not valid against the 2020-12 metaschema: {exc.message}")
        docs[uri] = doc
        registry = registry.with_resource(
            uri, Resource.from_contents(doc, default_specification=DRAFT202012)
        )
    return registry, docs


def check_refs(registry, docs):
    for uri, doc in docs.items():
        resolver = registry.resolver(base_uri=uri)
        stack = [doc]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                ref = node.get("$ref")
                if isinstance(ref, str):
                    try:
                        resolver.lookup(ref)
                    except Exception as exc:  # referencing raises several types
                        fail(uri.replace(BASE, "schema/"), f"unresolvable $ref {ref!r}: {exc!r}")
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)


def check_chunk(where, doc):
    try:
        raw = base64.b64decode(doc.get("message_chunk_base64", ""), validate=True)
    except (TypeError, ValueError) as exc:
        fail(where, f"message_chunk_base64 is not base64: {exc}")
        return
    if len(raw) > MAX_SEGMENT_BYTES:
        fail(where, f"segment decodes to {len(raw)} bytes, cap is {MAX_SEGMENT_BYTES}")
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        fail(where, "segment does not decode as UTF-8")
    if doc.get("segment_id", 0) >= doc.get("segment_count", 0):
        fail(where, "segment_id must be less than segment_count")


def check_expect(where, expect, message, registry):
    if not isinstance(expect, dict):
        fail(where, "$expect must be an object")
        return
    ref = expect.get("schema")
    at = expect.get("at")
    if not isinstance(ref, str) or "#/$defs/" not in ref:
        fail(where, "$expect.schema must look like file.json#/$defs/name")
        return
    if at not in AT_VALUES:
        fail(where, f"$expect.at must be one of {AT_VALUES}")
        return
    if not isinstance(message, dict):
        fail(where, "example has no message object")
        return
    if at == "message":
        target = message
    else:
        if at not in message:
            fail(where, f"message has no '{at}' to check against {ref}")
            return
        target = message[at]
    if at == "params":
        name = unescape_pointer(ref.split("#/$defs/", 1)[1])
        expected_method = name[: -len(".params")] if name.endswith(".params") else name
        if message.get("method") != expected_method:
            fail(where, f"method {message.get('method')!r} does not match schema {name!r}")
    try:
        validator = Draft202012Validator({"$ref": BASE + ref}, registry=registry)
        err = first_error(validator, target)
    except Exception as exc:
        fail(where, f"cannot validate against {ref}: {exc!r}")
        return
    if err:
        fail(where, f"{at} does not match {ref}: {err}")


def check_examples(registry):
    paths = sorted(EXAMPLE_DIR.glob("*.json"))
    if not paths:
        fail("examples", "no example files found")
    env = Draft202012Validator({"$ref": ENVELOPE}, registry=registry)
    msg = Draft202012Validator({"$ref": MESSAGE}, registry=registry)
    for path in paths:
        where = f"examples/{path.name}"
        if not re.fullmatch(r"\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.json", path.name):
            fail(where, "file name must be nn-slug.json")
        doc = load_json(path, where)
        if not isinstance(doc, dict):
            fail(where, "top level must be a JSON object")
            continue
        expect = doc.pop("$expect", None)
        err = first_error(env, doc)
        if err:
            fail(where, f"envelope does not match envelope.json: {err}")
        message = doc.get("message")
        if "message" in doc:
            err = first_error(msg, message)
            if err:
                fail(where, f"message does not match message.json: {err}")
        kind = doc.get("type")
        if kind in MESSAGE_TYPES and expect is None:
            fail(where, "a *_message example needs a $expect key")
        if kind in CHUNK_TYPES:
            check_chunk(where, doc)
        if expect is not None:
            check_expect(where, expect, message, registry)


def envelope_base(mtype, **extra):
    base = {"type": mtype, "client_id": "dev_8f3a9c21", "stream_id": UUID, "seq_id": 1}
    base.update(extra)
    return base


NEGATIVE = [
    ("envelope seq_id 0 is rejected", "envelope.json",
     envelope_base("ping", seq_id=0, state="foreground")),
    ("envelope ping with unknown state is rejected", "envelope.json",
     envelope_base("ping", state="sleeping")),
    ("error with unknown code is rejected", "message.json",
     {"id": 1, "error": {"code": "bogus", "message": "x"}}),
    ("method with capital first letter is rejected", "message.json",
     {"id": 1, "method": "Turn/start", "params": {}}),
    ("message with both method and result is rejected", "message.json",
     {"id": 1, "method": "ping", "result": {}}),
    ("session/start without cwd is rejected", "methods.json#/$defs/session~1start.params",
     {"agentId": "codex"}),
    ("turn/completed with inProgress status is rejected", "events.json#/$defs/turn~1completed",
     {"sessionId": "ses_1", "seq": 5, "turn": {"turnId": "trn_1", "status": "inProgress",
      "startedAt": 1, "completedAt": None, "error": None, "items": []}}),
    ("item/delta with seq 0 is rejected", "events.json#/$defs/item~1delta",
     {"sessionId": "ses_1", "seq": 0, "itemId": "itm_1", "turnId": "trn_1",
      "field": "text", "delta": "x"}),
    ("snapshot without pending is rejected", "methods.json#/$defs/session~1open.result.snapshot",
     {"mode": "snapshot", "session": None, "turns": [], "cursor": 1}),
    ("item with unknown type is rejected", "common.json#/$defs/Item",
     {"itemId": "itm_1", "type": "hologram", "turnId": "trn_1", "status": "completed"}),
    ("provider/chat naming no provider is rejected", "methods.json#/$defs/provider~1chat.params",
     {"requestId": "r1", "model": "m", "messages": [{"role": "user", "content": "hi"}]}),
    ("provider/done failed without error is rejected", "events.json#/$defs/provider~1done",
     {"requestId": "r1", "status": "failed"}),
    ("provider/delta with unknown kind is rejected", "events.json#/$defs/provider~1delta",
     {"requestId": "r1", "kind": "tool", "text": "x"}),
    ("agent capabilities without approvalModes is rejected", "common.json#/$defs/Agent",
     {"id": "pi", "name": "Pi", "status": "ready", "capabilities": {"steer": True, "diff": False}}),
    ("agent capabilities with a non-boolean steer is rejected", "common.json#/$defs/Agent",
     {"id": "pi", "name": "Pi", "status": "ready",
      "capabilities": {"steer": "yes", "diff": False, "approvalModes": []}}),
    ("turn/diff file with an unknown kind is rejected", "methods.json#/$defs/turn~1diff.result",
     {"files": [{"path": "a.txt", "kind": "renamed", "diff": ""}]}),
    ("provider/list entry carrying no hasKey is rejected", "common.json#/$defs/ProviderInfo",
     {"id": "p1", "name": "Ollama", "baseURL": "http://127.0.0.1:11434", "kind": "ollama"}),
    ("host/settings/update with an unknown keepAwake value is rejected",
     "methods.json#/$defs/host~1settings~1update.params", {"keepAwake": "always"}),
    ("host/settings/update with no setting is rejected",
     "methods.json#/$defs/host~1settings~1update.params", {}),
    ("host/status keepAwake without active is rejected", "common.json#/$defs/HostStatus",
     {"host": {"hostId": "host_1", "name": "m", "version": "0.1.0", "os": "darwin", "arch": "arm64"},
      "agents": [], "sessionsActive": 0, "uptimeSeconds": 1,
      "keepAwake": {"setting": "pluggedIn", "onBattery": False}}),
]


def check_negatives(registry):
    for label, ref, instance in NEGATIVE:
        try:
            validator = Draft202012Validator({"$ref": BASE + ref}, registry=registry)
            err = first_error(validator, instance)
        except Exception as exc:
            fail(f"negative: {label}", f"validator error: {exc!r}")
            continue
        if err is None:
            fail(f"negative: {label}", f"instance was accepted by {ref}")


def main():
    registry, docs = build_registry()
    check_refs(registry, docs)
    check_examples(registry)
    check_negatives(registry)
    if failures:
        print(f"FAILED: {len(failures)} problem(s)")
        for item in failures:
            print(f" - {item}")
        return 1
    n_examples = len(list(EXAMPLE_DIR.glob("*.json")))
    print(f"OK: {len(docs)} schemas, {n_examples} examples, {len(NEGATIVE)} negative cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
