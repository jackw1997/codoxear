from __future__ import annotations

import base64
import io
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from codoxear.voice_harmony_push import HarmonyPush, sign_jwt, alert_payload


@pytest.fixture
def provider(tmp_path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    account = {"project_id": "12345", "key_id": "test-key-id", "sub_account": "test-account",
               "token_uri": "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
               "private_key": key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()}
    path = tmp_path / 'account.json'
    path.write_text(json.dumps(account))
    push = HarmonyPush(tmp_path / 'registrations.json', account_path=str(path), test_message=True)
    return push, account, key


def registration(token='fake-token', device='a' * 32):
    return {"device_id": device, "token": token, "server": "https://codoxear.example/nested/api/me"}


def test_jwt_signature_and_expiry(provider):
    _, account, key = provider
    encoded = sign_jwt(account, 1000)
    h, p, s = encoded.split('.')
    decode = lambda text: base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))
    assert json.loads(decode(h)) == {"alg": "PS256", "typ": "JWT", "kid": "test-key-id"}
    assert json.loads(decode(p)) == {"iss": "test-account", "aud": account['token_uri'], "iat": 1000, "exp": 4600}
    key.public_key().verify(decode(s), (h + '.' + p).encode(), padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32), hashes.SHA256())


def test_rotation_persistence_disable_and_no_token_in_status(provider):
    push, _, _ = provider
    assert push.register(registration()) == {"registered": True}
    assert push.path.stat().st_mode & 0o777 == 0o600
    push.register(registration('rotated'))
    push.unregister(registration())  # stale disable cannot erase rotated token
    restored = HarmonyPush(push.path, account_path=push.account_path)
    assert restored.records['a' * 32]['token'] == 'rotated'
    assert restored.status() == {"configured": True, "test_message": False}
    restored.unregister(registration('rotated'))
    assert json.loads(push.path.read_text()) == {}


def test_duplicate_token_is_one_delivery(provider):
    push, _, _ = provider
    push.register(registration())
    push.register(registration(device='b' * 32))
    assert list(push.records) == ['b' * 32]


def test_unconfigured_rejects_registration_but_can_disable(tmp_path):
    push = HarmonyPush(tmp_path / 'push.json', account_path='')
    assert push.status()['configured'] is False
    with pytest.raises(ValueError, match='not configured'):
        push.register(registration())
    assert push.unregister(registration()) == {"registered": False}
    assert not push.path.exists()


@pytest.mark.parametrize('change', [{'device_id': 'short'}, {'token': 'bad token'}, {'server': 'https://user:secret@host/api/me'}, {'server': 'file:///api/me'}, {'server': 'https://host/api/me?token=x'}])
def test_invalid_registration_rejected(provider, change):
    push, _, _ = provider
    with pytest.raises(ValueError):
        push.register({**registration(), **change})
    assert not push.records


def test_delivery_posts_v3_jwt_and_click_route(provider):
    push, _, _ = provider
    push.register(registration())
    event = {"session_id": "session-one", "session_display_name": "中文工作", "message_id": "final:1", "notification_text": "Finished"}
    captured = []
    def send(request, timeout):
        captured.append(request)
        assert timeout == 10
        return io.BytesIO(b'{"code":"80000000","msg":"Success"}')
    with patch('urllib.request.OpenerDirector.open', lambda self, request, timeout: send(request, timeout)):
        result = push.send(event)
    assert result[0].success
    request = captured[0]
    assert request.full_url == 'https://push-api.cloud.huawei.com/v3/12345/messages:send'
    assert request.headers['Push-type'] == '0'
    assert request.headers['Authorization'].startswith('Bearer ')
    body = json.loads(request.data)
    assert body['target']['token'] == ['fake-token']
    assert body['payload']['notification']['clickAction']['data'] == {'codoxear.session': 'session-one', 'codoxear.server': registration()['server']}
    assert body['pushOptions'] == {'ttl': 300, 'testMessage': True}
    assert push.records['a' * 32]['last_error'] == ''


def test_http200_business_error_is_not_delivery_and_does_not_leak_response(provider):
    push, _, _ = provider
    push.register(registration())
    with patch('urllib.request.OpenerDirector.open', return_value=io.BytesIO(b'{"code":"80300007","msg":"secret token fake-token"}')):
        result = push.send({'message_id': '1'})
    assert not result[0].success
    assert result[0].error == 'HarmonyOS push rejected: 80300007'
    assert 'fake-token' not in result[0].error
    assert result[0].drop_subscription
    assert not push.records
    assert json.loads(push.path.read_text()) == {}


def test_payload_stays_below_limit_and_preserves_unicode():
    payload = alert_payload(registration(), {'notification_text': '🌊' * 9000, 'session_display_name': '中文' * 1000, 'session_id': 'x' * 1000, 'message_id': 'a'}, test_message=False)
    assert len(json.dumps({k: v for k, v in payload.items() if k != 'target'}, ensure_ascii=False).encode()) < 4096
    assert payload['payload']['notification']['body'] == '🌊' * 400


def test_disk_failure_does_not_enable_or_remove_registration(provider):
    push, _, _ = provider
    with patch.object(push, '_save', side_effect=OSError('disk full')):
        with pytest.raises(OSError):
            push.register(registration())
    assert not push.records
    push.register(registration())
    with patch.object(push, '_save', side_effect=OSError('disk full')):
        with pytest.raises(OSError):
            push.unregister(registration())
    assert push.records['a' * 32]['token'] == 'fake-token'


def test_json_escaping_is_counted_in_payload_limit():
    payload = alert_payload(registration(), {'notification_text': '\x00' * 9000, 'session_display_name': '\x01' * 1000, 'session_id': 'x' * 1000}, test_message=False)
    assert len(json.dumps({k: v for k, v in payload.items() if k != 'target'}, ensure_ascii=False).encode()) <= 4096


def test_telemetry_disk_failure_does_not_reclassify_accepted_delivery(provider):
    push, _, _ = provider
    push.register(registration())
    with patch('urllib.request.OpenerDirector.open', return_value=io.BytesIO(b'{"code":"80000000"}')), patch.object(push, '_save', side_effect=OSError('disk full')):
        assert push.send({'message_id': 'one'})[0].success


def test_final_response_dispatches_to_native_without_web_subscriptions(provider, tmp_path):
    import threading
    from codoxear.voice_push import VoicePushCoordinator
    push, _, _ = provider
    push.register(registration())
    stop = threading.Event()
    stop.set()  # Exercise delivery directly with background workers stopped.
    coord = VoicePushCoordinator(app_dir=tmp_path, stop_event=stop, settings_path=tmp_path/'settings.json', subscriptions_path=tmp_path/'web.json', delivery_ledger_path=tmp_path/'ledger.json', vapid_private_key_path=tmp_path/'vapid.pem')
    coord.harmony_push = push
    coord._delivery_ledger['final-one'] = {'message_id': 'final-one'}
    with patch('urllib.request.OpenerDirector.open', return_value=io.BytesIO(b'{"code":"80000000"}')) as transport:
        coord._send_push_notifications(session_id='one', session_display_name='One', message_id='final-one', notification_text='Finished', timestamp=1.0)
    assert transport.call_count == 1
    assert coord._delivery_ledger['final-one']['push_status'] == 'sent'
    push.unregister(registration())
    coord._send_push_notifications(session_id='one', session_display_name='One', message_id='final-one', notification_text='Finished', timestamp=1.0)
    assert coord._delivery_ledger['final-one']['push_status'] == 'skipped'
