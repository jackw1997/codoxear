"""Behavioral coverage for current Codex CLI retained user messages."""
from copy import deepcopy
import json

from codoxear.codex_user import codex_retained_user_text
from codoxear.rollout_chat_batch import _extract_chat_events
from codoxear.rollout_chat_events import _sidebar_conversation_ts
from codoxear.rollout_idle import _analyze_log_chunk, _compute_idle_from_log, _last_chat_role_ts_from_tail
from codoxear.rollout_log import _read_chat_tail_page, _read_chat_live_delta


def user(text='visible prompt', kind='user.text'):
    return {'type':'response_item','ts':1.0,'payload':{
        'type':'message','role':'user','id':'msg-one',
        'content':[{'type':'input_text','text':text}],
        'internal_chat_message_metadata_passthrough':{'content_item_kinds':[kind]}},
        'metadata':{'retained_source':{'complete':True},'user_input_order':0}}


def test_user_provenance_filters_environment_and_legacy_mirrors():
    row=user()
    assert codex_retained_user_text(row)=='visible prompt'
    assert codex_retained_user_text(user('secret environment','environments.environment_context')) is None
    for change in ('no_metadata','incomplete','no_kinds','wrong_role','mismatched_parts'):
        row=user()
        if change=='no_metadata':row.pop('metadata')
        if change=='incomplete':row['metadata']['retained_source']['complete']=False
        if change=='no_kinds':row['payload'].pop('internal_chat_message_metadata_passthrough')
        if change=='wrong_role':row['payload']['role']='developer'
        if change=='mismatched_parts':row['payload']['content'].append({'type':'input_text','text':'hidden'})
        assert codex_retained_user_text(row) is None


def test_mixed_content_preserves_only_user_text_and_unicode():
    row=user('hello 中文😀')
    row['payload']['content'].append({'type':'input_text','text':'private harness'})
    row['payload']['internal_chat_message_metadata_passthrough']['content_item_kinds'].append('environments.environment_context')
    events,_,flags,_=_extract_chat_events([row])
    assert [(e['role'],e['text']) for e in events]==[('user','hello 中文😀')]
    assert flags['turn_start']
    assert _sidebar_conversation_ts(row)==1.0
    *_,state=_analyze_log_chunk([row])
    assert state.turn_open and state.counters_reset


def test_tail_live_and_no_response_use_retained_user_boundary(tmp_path):
    path=tmp_path/'rollout-retained.jsonl'
    hidden=user('environment','environments.environment_context')
    rows=[hidden,user()]
    path.write_text(''.join(json.dumps(r)+'\n' for r in rows))
    before=path.stat().st_size
    tail,_,_,_=_read_chat_tail_page(path,limit=20)
    assert [(e['role'],e['text']) for e in tail]==[('user','visible prompt')]
    assert _compute_idle_from_log(path) is False
    assert _last_chat_role_ts_from_tail(path,max_scan_bytes=8*1024*1024)==('user',1.0)
    close={'type':'event_msg','ts':2.0,'payload':{'type':'task_complete'}}
    with path.open('a') as f:f.write(json.dumps(close)+'\n')
    live,*_=_read_chat_live_delta(path,after_byte=before)
    assert len(live)==1 and live[0]['message_class']=='error'
    assert 'without producing a response' in live[0]['text']
    assert _compute_idle_from_log(path) is True


def test_repeated_user_input_is_not_collapsed():
    first=user('same');second=deepcopy(first);second['ts']=3.0;second['payload']['id']='msg-two'
    assistant={'type':'event_msg','ts':2.0,'payload':{'type':'agent_message','phase':'final_answer','message':'answer'}}
    events,_,_,_=_extract_chat_events([first,assistant,second])
    assert [e['role'] for e in events]==['user','assistant','user']


def test_embedded_terminal_error_appears_in_tail_and_live(tmp_path):
    path = tmp_path / 'rollout-error.jsonl'
    path.write_text(json.dumps(user('你好')) + '\n')
    before = path.stat().st_size
    failure = "The 'GPT-6-Astra' model is not supported when using Codex with a ChatGPT account."
    close = {'type': 'event_msg', 'ts': 2.0, 'payload': {
        'type': 'task_complete', 'last_agent_message': None, 'error': {'message': failure}}}
    with path.open('a') as f:
        f.write(json.dumps(close) + '\n')
    tail, *_ = _read_chat_tail_page(path, limit=20)
    assert [(e['role'], e['text']) for e in tail] == [('user', '你好'), ('assistant', failure)]
    live, *_ = _read_chat_live_delta(path, after_byte=before)
    assert len(live) == 1 and live[0]['text'] == failure and live[0]['message_class'] == 'error'
