import json
from pathlib import Path

from codoxear.broker_launch import _session_log_path_from_args


def write_log(root: Path, sid: str, text: str) -> Path:
    path = root / '-work' / (sid + '.jsonl')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'type': 'user', 'sessionId': sid, 'cwd': '/work',
        'timestamp': '2026-01-01T00:00:00Z', 'message': {'role': 'user', 'content': text}}) + '\n')
    return path


def test_cc_explicit_resume_binds_old_log_before_first_new_turn(tmp_path):
    sid = '9e216455-5b45-4593-b374-c0f60b0c48c4'
    old = write_log(tmp_path, sid, 'Old retained conversation')
    write_log(tmp_path, 'b1758849-706b-4cd9-95f3-e5a7255c69cb', 'Different conversation')
    selected = _session_log_path_from_args(args=['--model', 'sonnet', '--resume', sid], agent_backend='cc', sessions_dir=tmp_path)
    assert selected == old
    assert json.loads(selected.read_text())['message']['content'] == 'Old retained conversation'


def test_cc_new_or_unresolved_resume_never_guesses_existing_log(tmp_path):
    write_log(tmp_path, '9e216455-5b45-4593-b374-c0f60b0c48c4', 'Unrelated history')
    for args in ([], ['--continue'], ['--resume'], ['--resume', 'missing-id']):
        assert _session_log_path_from_args(args=args, agent_backend='cc', sessions_dir=tmp_path) is None
