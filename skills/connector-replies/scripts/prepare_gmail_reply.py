#!/usr/bin/env python3
"""Prepare native Gmail draft arguments from a fetched parent; never send mail."""
import html
import json
import re
import sys
from email.utils import getaddresses


def header_map(message):
    result = {}
    for header in message.get('payload', {}).get('headers', []):
        result.setdefault(header['name'].lower(), []).append(header['value'])
    return result


def single(headers, name):
    values = headers.get(name, [])
    if len(values) != 1 or not values[0].strip() or '\r' in values[0] or '\n' in values[0]:
        raise ValueError('A single valid ' + name + ' header is required from the fetched parent.')
    return values[0]


def addresses(value):
    if '\n' in value or '\r' in value:
        raise ValueError('Address headers cannot contain newlines.')
    result = [address for _, address in getaddresses([value]) if address]
    if any('@' not in address for address in result):
        raise ValueError('A valid email address is required.')
    return result


def prepare(data):
    parent = data['parent']
    if not isinstance(parent, dict) or not isinstance(data.get('link_id'), str) or not data['link_id'].strip():
        raise ValueError('A fetched parent and selected account link_id are required.')
    if not isinstance(data.get('account_email'), str) or not isinstance(data.get('body_text'), str):
        raise ValueError('account_email and body_text must be strings.')
    message_id, thread_id = parent.get('id'), parent.get('thread_id')
    # Message and thread IDs can legitimately be equal for a thread's first mail.
    if not isinstance(message_id, str) or not message_id or re.search(r'[\s<>@/:]', message_id):
        raise ValueError('Use the immutable Gmail message id from read_email, not an RFC Message-ID or browser URL.')
    if not isinstance(thread_id, str) or not thread_id:
        raise ValueError('The fetched parent must include its Gmail thread_id.')
    headers = header_map(parent)
    rfc_id = single(headers, 'message-id')
    if not re.fullmatch(r'<[^<>\s]+@[^<>\s]+>', rfc_id):
        raise ValueError('The fetched parent has no valid RFC Message-ID for reply verification.')
    subjects = headers.get('subject', [''])
    if len(subjects) != 1 or '\r' in subjects[0] or '\n' in subjects[0]:
        raise ValueError('A valid subject header is required from the fetched parent.')
    subject = subjects[0]
    account_email = data['account_email'].strip().lower()
    if len(addresses(account_email)) != 1:
        raise ValueError('Choose the authenticated account explicitly.')
    explicit_recipient = bool(data.get('to'))
    if explicit_recipient:
        recipients = addresses(data['to'])
    else:
        senders = addresses(single(headers, 'from'))
        if senders and all(address.lower() == account_email for address in senders):
            recipients = addresses(single(headers, 'to'))
        else:
            recipients = addresses(single(headers, 'reply-to') if 'reply-to' in headers else single(headers, 'from'))
    recipients = list(dict.fromkeys(address for address in recipients if explicit_recipient or address.lower() != account_email))
    if not recipients:
        raise ValueError('No reply recipient found; choose the intended destination explicitly.')
    text = data['body_text'].replace('\r\n', '\n').replace('\r', '\n')
    if not text.strip():
        raise ValueError('The new reply body is empty.')
    # Parent content is deliberately ignored: Gmail threading is carried by
    # headers, not by copying a plain-text > quote chain into the authored reply.
    rich = '<div>' + '</div><div><br></div><div>'.join(
        html.escape(paragraph, quote=False).replace('\n', '<br>') for paragraph in text.split('\n\n')) + '</div>'
    return {
        'arguments': {
            'link_id': data['link_id'], 'to': ', '.join(recipients), 'subject': subject,
            'reply_message_id': message_id,
            'payload': {'mime_type': 'multipart/alternative', 'parts': [
                {'mime_type': 'text/plain', 'charset': 'utf-8', 'body': {'content': text}},
                {'mime_type': 'text/html', 'charset': 'utf-8', 'body': {'content': rich}}
            ]}
        },
        'verification': {'expected_thread_id': thread_id, 'expected_in_reply_to': rfc_id,
                         'original_body_copied': False, 'new_message_sent': False}
    }


def verify(data):
    prepared = data['prepared']
    draft = data['draft'].get('message', data['draft'])
    expected = prepared['verification']
    arguments = prepared['arguments']
    if 'DRAFT' not in draft.get('label_ids', []):
        raise ValueError('Read back the unsent draft message before approving a send.')
    if draft.get('thread_id') != expected['expected_thread_id']:
        raise ValueError('The saved draft is not in the expected Gmail thread.')
    headers = header_map(draft)
    if single(headers, 'in-reply-to') != expected['expected_in_reply_to']:
        raise ValueError('The saved draft does not reply to the expected RFC parent.')
    if expected['expected_in_reply_to'] not in ' '.join(headers.get('references', [])).split():
        raise ValueError('The saved draft References header omits its parent.')
    actual_to = sorted(address.lower() for address in addresses(single(headers, 'to')))
    wanted_to = sorted(address.lower() for address in addresses(arguments['to']))
    if actual_to != wanted_to:
        raise ValueError('The saved draft recipients differ from the prepared reply.')
    normalize_subject = lambda value: re.sub(r'^(?:re:\s*)+', '', value.strip(), flags=re.I)
    if normalize_subject(' '.join(headers.get('subject', ['']))) != normalize_subject(arguments['subject']):
        raise ValueError('The saved draft subject differs from its parent.')
    leaves = []
    def visit(part):
        if not part.get('filename'):
            leaves.append(part)
        for child in part.get('parts') or []:
            visit(child)
    visit(draft.get('payload', {}))
    normalize_lines = lambda value: value.replace('\r\n', '\n').replace('\r', '\n').rstrip('\n')
    for wanted in arguments['payload']['parts']:
        matches = [part for part in leaves if part.get('mime_type') == wanted['mime_type']]
        if len(matches) != 1 or normalize_lines(matches[0].get('body', {}).get('content') or '') != normalize_lines(wanted['body']['content']):
            raise ValueError('The saved ' + wanted['mime_type'] + ' body changed or acquired an unwanted quote chain.')
    return {'valid': True, 'thread_id': draft['thread_id'],
            'validation_scope': 'provided draft data; the caller must obtain it through native Gmail',
            'new_message_sent': False}


if __name__ == '__main__':
    try:
        operation = verify if sys.argv[1:] == ['verify'] else prepare
        if sys.argv[1:] and sys.argv[1:] != ['verify']:
            raise ValueError('Use no argument to prepare, or verify to check native draft readback.')
        json.dump(operation(json.load(sys.stdin)), sys.stdout, ensure_ascii=False, indent=2)
        print()
    except (KeyError, TypeError, ValueError) as error:
        raise SystemExit(str(error))
