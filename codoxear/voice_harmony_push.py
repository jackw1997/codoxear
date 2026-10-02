"""Opt-in HarmonyOS PushKit alerts. No provider credential is exposed by routes."""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from .util import load_json_file
from .voice_push_state import _b64u, _sha256_hex
from .voice_webpush import WebPushDeliveryOutcome


def sign_jwt(account: dict[str, Any], now: int) -> str:
    """PS256 / 32-byte PSS salt per JWT, using Huawei service-account claims."""
    header = {"alg": "PS256", "typ": "JWT", "kid": account["key_id"]}
    claims = {"iss": account["sub_account"], "aud": account["token_uri"], "iat": now, "exp": now + 3600}
    pieces = [_b64u(json.dumps(value, separators=(",", ":")).encode()) for value in (header, claims)]
    key = serialization.load_pem_private_key(account["private_key"].encode(), password=None)
    if not isinstance(key, rsa.RSAPrivateKey) or key.key_size < 2048:
        raise ValueError("HarmonyOS push requires an RSA service-account key of at least 2048 bits")
    message = ".".join(pieces).encode("ascii")
    signature = key.sign(message, padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32), hashes.SHA256())
    return message.decode() + "." + _b64u(signature)


def _text(raw: Any, limit: int) -> str:
    return str(raw or "").encode("utf-8")[:limit].decode("utf-8", errors="ignore")


def alert_payload(record: dict[str, Any], event: dict[str, Any], *, test_message: bool) -> dict[str, Any]:
    payload = {
        "payload": {"notification": {
            "category": "WORK", "title": _text(event.get("session_display_name") or "Codoxear", 256),
            "body": _text(event.get("notification_text"), 1600),
            "appMessageId": _sha256_hex(record["server"] + "\n" + str(event.get("message_id") or "")),
            "clickAction": {"actionType": 0, "data": {
                "codoxear.session": _text(event.get("session_id"), 256), "codoxear.server": record["server"],
            }},
        }},
        "target": {"token": [record["token"]]},
        "pushOptions": {"ttl": 300, "testMessage": test_message},
    }

    # JSON escaping can be much larger than UTF-8 input (for example control
    # characters). Huawei excludes target tokens from its 4096-byte limit.
    notification = payload["payload"]["notification"]
    def size() -> int:
        return len(json.dumps({k: v for k, v in payload.items() if k != "target"}, ensure_ascii=False).encode())
    body = notification["body"]
    low, high = 0, len(body)
    while size() > 4096 and low < high:
        high = (low + high) // 2
        notification["body"] = body[:high]
    return payload


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HarmonyPush:
    def __init__(self, path: Path, *, account_path: str | None = None, test_message: bool | None = None) -> None:
        self.path = path
        self.account_path = account_path if account_path is not None else os.environ.get("CODEX_WEB_HARMONY_PUSH_ACCOUNT", "")
        self.test_message = test_message if test_message is not None else os.environ.get("CODEX_WEB_HARMONY_PUSH_TEST", "0") == "1"
        self.lock = threading.RLock()
        try:
            raw = load_json_file(path, default={})
        except (ValueError, OSError):
            raw = {}
        self.records: dict[str, dict[str, Any]] = {}
        if isinstance(raw, dict):
            for value in raw.values():
                try:
                    clean = self._clean(value)
                    self.records[clean["device_id"]] = {**value, **clean}
                except (ValueError, TypeError):
                    continue

    @staticmethod
    def _clean(raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise ValueError("registration must be an object")
        device = raw.get("device_id")
        if not isinstance(device, str) or not re.fullmatch(r"[A-Za-z0-9_-]{24,128}", device):
            raise ValueError("invalid device_id")
        token = raw.get("token")
        if not isinstance(token, str) or not 1 <= len(token) <= 4096 or any(c.isspace() for c in token):
            raise ValueError("invalid push token")
        server = raw.get("server")
        if not isinstance(server, str) or len(server.encode()) > 512:
            raise ValueError("invalid server address")
        parsed = urllib.parse.urlsplit(server)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.path.endswith("/api/me"):
            raise ValueError("invalid server address")
        return {"device_id": device, "token": token, "server": server}

    def _account(self) -> dict[str, Any]:
        if not self.account_path:
            raise ValueError("HarmonyOS background push is not configured on this server")
        try:
            account = json.loads(Path(self.account_path).read_text())
            if not all(isinstance(account.get(k), str) and account[k] for k in ("project_id", "key_id", "private_key", "sub_account", "token_uri")):
                raise ValueError()
            if not re.fullmatch(r"[A-Za-z0-9_-]+", account["project_id"]):
                raise ValueError()
            sign_jwt(account, int(time.time()))
            return account
        except (OSError, ValueError, TypeError, AttributeError, KeyError, UnsupportedAlgorithm):
            raise ValueError("HarmonyOS push service-account configuration is invalid") from None

    def status(self) -> dict[str, Any]:
        try:
            self._account()
            return {"configured": True, "test_message": self.test_message}
        except ValueError as error:
            return {"configured": False, "reason": str(error)}

    def _save(self) -> None:
        # Both temporary and final files are private, including the first write.
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                json.dump(self.records, stream)
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)

    def register(self, raw: dict[str, Any]) -> dict[str, Any]:
        clean = self._clean(raw)
        self._account()
        with self.lock:
            # A token cannot cause duplicate deliveries after local state recovery.
            previous = self.records
            self.records = {k: v for k, v in self.records.items() if v["token"] != clean["token"] or k == clean["device_id"]}
            self.records[clean["device_id"]] = {**clean, "updated_ts": time.time()}
            try:
                self._save()
            except OSError:
                self.records = previous
                raise
        return {"registered": True}

    def unregister(self, raw: dict[str, Any]) -> dict[str, Any]:
        clean = self._clean(raw)
        with self.lock:
            record = self.records.get(clean["device_id"])
            # A late disable for an old token must not erase a rotated token.
            if record and record["token"] == clean["token"]:
                del self.records[clean["device_id"]]
                try:
                    self._save()
                except OSError:
                    self.records[clean["device_id"]] = record
                    raise
        return {"registered": False}

    def send(self, event: dict[str, Any]) -> list[WebPushDeliveryOutcome]:
        with self.lock:
            records = [dict(record) for record in self.records.values()]
        if not records:
            return []
        try:
            account = self._account()
            jwt = sign_jwt(account, int(time.time()))
        except ValueError as error:
            return [WebPushDeliveryOutcome(record_id=r["device_id"], success=False, timestamp=time.time(), error=str(error)) for r in records]
        outcomes = []
        for record in records:
            # Recheck after potentially slow delivery to previous devices.
            with self.lock:
                if self.records.get(record["device_id"], {}).get("token") != record["token"]:
                    continue
            request = urllib.request.Request(
                "https://push-api.cloud.huawei.com/v3/" + account["project_id"] + "/messages:send",
                data=json.dumps(alert_payload(record, event, test_message=self.test_message), ensure_ascii=False).encode(),
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + jwt, "push-type": "0"}, method="POST")
            success = False
            invalid_token = False
            error = ""
            try:
                with urllib.request.build_opener(_NoRedirect()).open(request, timeout=10) as response:
                    result = json.loads(response.read(65536))
                code = str(result.get("code") or "")
                success = code == "80000000"
                invalid_token = code == "80300007"
                if not success:
                    error = "HarmonyOS push rejected: " + (code if re.fullmatch(r"[0-9]{1,12}", code) else "invalid response")
            except urllib.error.HTTPError as failure:
                error = "HarmonyOS push HTTP " + str(failure.code)
            except (OSError, ValueError, TypeError, AttributeError):
                error = "HarmonyOS push transport failed"
            now = time.time()
            outcomes.append(WebPushDeliveryOutcome(record_id=record["device_id"], success=success, timestamp=now, error=error, drop_subscription=invalid_token))
            with self.lock:
                current = self.records.get(record["device_id"])
                if current and current["token"] == record["token"]:
                    if invalid_token:
                        del self.records[record["device_id"]]
                    current["last_error"] = error
                    current["last_success_ts" if success else "last_failure_ts"] = now
                    try:
                        self._save()
                    except OSError:
                        pass  # Delivery already happened; never replay it for a telemetry write.
        return outcomes
