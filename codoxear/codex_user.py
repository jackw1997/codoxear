"""User text in retained-message Codex rollouts.

Newer CLI logs store visible user input as response_item messages with explicit
content provenance instead of event_msg.user_message. Environment and harness
messages also have role=user, so role alone is never a visibility signal.
"""
from __future__ import annotations

from typing import Any, Mapping


def codex_retained_user_text(obj: Mapping[str, Any]) -> str | None:
    if obj.get("type") != "response_item":
        return None
    payload = obj.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "message" or payload.get("role") != "user":
        return None
    metadata = obj.get("metadata")
    retained = metadata.get("retained_source") if isinstance(metadata, dict) else None
    if not isinstance(retained, dict) or retained.get("complete") is not True:
        return None
    provenance = payload.get("internal_chat_message_metadata_passthrough")
    kinds = provenance.get("content_item_kinds") if isinstance(provenance, dict) else None
    content = payload.get("content")
    if not isinstance(content, list) or not isinstance(kinds, list) or len(content) != len(kinds):
        return None
    parts = [part["text"] for part, kind in zip(content, kinds)
             if kind == "user.text" and isinstance(part, dict)
             and part.get("type") == "input_text" and isinstance(part.get("text"), str)]
    return "".join(parts) if parts else None
