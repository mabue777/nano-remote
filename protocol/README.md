# Nano Remote protocol v1: schemas and fixtures

- `protocol-v1.md`: the spec. Normative for behavior.
- `schema/`: JSON Schema (2020-12) for message shapes. Start at `envelope.json`.
  Method params and results live in `methods.json`; notifications live in `events.json`.
- `examples/`: one complete envelope per file, checked against the schemas.
  Each file has a `$expect` key naming the schema its message must match; the key is removed before the envelope check.
- `verify.py`: checks every schema, every `$ref`, every example, and a set of must-fail cases.

Verify, from the repo root: `python3 -I protocol/verify.py`
