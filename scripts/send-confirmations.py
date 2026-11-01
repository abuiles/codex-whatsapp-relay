#!/usr/bin/env python3
"""Opt-in Codex prompts for final sends; no network calls or message drafts."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import tomllib

BEGIN = '# BEGIN whatsapp-relay send-confirmations v1\n'
END = '# END whatsapp-relay send-confirmations v1\n'


def render(targets, enabled):
    metadata = json.dumps({'targets': targets, 'enabled': enabled}, separators=(',', ':'))
    lines = [BEGIN, '# policy: ' + metadata + '\n']
    if enabled:
        grouped = {}
        for target in targets:
            grouped.setdefault(tuple(target['path'][:-1]), []).append(target)
        for table, values in grouped.items():
            lines.append('[' + '.'.join(json.dumps(key) for key in table) + ']\n')
            for target in values:
                lines.append(json.dumps(target['path'][-1]) + ' = ' + json.dumps(target['value']) + '\n')
    return ''.join(lines) + END


def extract(text):
    if BEGIN not in text and END not in text:
        return text, None
    if text.count(BEGIN) != 1 or text.count(END) != 1:
        raise ValueError('Malformed managed policy block; inspect config manually.')
    start = text.index(BEGIN)
    stop = text.index(END, start) + len(END)
    block = text[start:stop]
    metadata = json.loads(block.splitlines()[1].removeprefix('# policy: '))
    if block != render(metadata['targets'], metadata['enabled']):
        raise ValueError('Managed block was edited; preserve it and reconcile manually.')
    return text[:start] + text[stop:], metadata


def lookup(data, keys):
    for key in keys:
        if not isinstance(data, dict) or key not in data:
            return None
        data = data[key]
    return data


def build_targets(config, slack_id=None, gmail_id=None):
    targets = []
    def add(keys, value):
        existing = lookup(config, keys)
        if existing is not None:
            if existing != value:
                raise ValueError('Existing policy differs for ' + '.'.join(keys) + '; not overriding it.')
            return  # Leave an existing matching policy owned by the user.
        targets.append({'path': keys, 'value': value})
    plugin_ids = [key for key in config.get('plugins', {}) if key.startswith('whatsapp-relay@')]
    servers = [['plugins', key, 'mcp_servers', 'whatsapp-relay'] for key in plugin_ids]
    if 'whatsapp-relay' in config.get('mcp_servers', {}):
        servers.append(['mcp_servers', 'whatsapp-relay'])
    for server in servers:
        for tool in ['whatsapp_send_message', 'whatsapp_send_media', 'whatsapp_react', 'whatsapp_edit_message',
                     'whatsapp_delete_message', 'whatsapp_forward_message', 'whatsapp_mark_read',
                     'whatsapp_send_poll', 'whatsapp_send_location', 'whatsapp_send_contact', 'whatsapp_schedule_message',
                     'whatsapp_status', 'whatsapp_manage_chat', 'whatsapp_group_admin', 'whatsapp_block',
                     'whatsapp_presence', 'whatsapp_watch']:
            add(server + ['tools', tool, 'approval_mode'], 'prompt')
        for tool in ['whatsapp_prepare_media', 'whatsapp_read_messages', 'whatsapp_list_chats', 'whatsapp_auth_status',
                     'whatsapp_message_status', 'whatsapp_sync_history', 'whatsapp_search_messages',
                     'whatsapp_wait_for_messages', 'whatsapp_check_number', 'whatsapp_contact_info',
                     'whatsapp_group_info', 'whatsapp_reconnect', 'whatsapp_inbox', 'whatsapp_digest',
                     'whatsapp_alerts', 'whatsapp_list_watches', 'whatsapp_unwatch', 'whatsapp_list_scheduled',
                     'whatsapp_cancel_scheduled', 'whatsapp_media_text']:
            add(server + ['tools', tool, 'approval_mode'], 'approve')
    slack_servers = [
        ['mcp_servers', name] for name, server in config.get('mcp_servers', {}).items()
        if server.get('url') == 'https://mcp.slack.com/mcp'
    ]
    for server in slack_servers:
        for tool in ['slack_send_message', 'slack_schedule_message', 'slack_edit_message', 'slack_complete_file_upload']:
            add(server + ['tools', tool, 'approval_mode'], 'prompt')
        for tool in ['slack_send_message_draft', 'slack_get_file_upload_url']:
            add(server + ['tools', tool, 'approval_mode'], 'approve')
    for app_id, tools in [(slack_id, ['slack_send_message', 'slack_schedule_message', 'slack_edit_message', 'slack_complete_file_upload']),
                          (gmail_id, ['send_email', 'send_draft', 'forward_emails'])]:
        if not app_id:
            continue
        add(['apps', app_id, 'approvals_reviewer'], 'user')
        for tool in tools:
            add(['apps', app_id, 'tools', tool, 'approval_mode'], 'prompt')
        drafts = ['slack_send_message_draft', 'slack_get_file_upload_url'] if app_id == slack_id else ['create_draft', 'update_draft']
        for tool in drafts:
            add(['apps', app_id, 'tools', tool, 'approval_mode'], 'approve')
    if not servers and not slack_servers and not slack_id and not gmail_id:
        raise ValueError('No configured WhatsApp Relay or official Slack MCP found. Supply connected Slack/Gmail app IDs if desired.')
    return targets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['on', 'off', 'status'])
    parser.add_argument('--config', type=Path, default=Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'config.toml')
    parser.add_argument('--slack-app-id')
    parser.add_argument('--gmail-app-id')
    args = parser.parse_args()
    args.config = args.config.expanduser().resolve()
    original = args.config.read_text() if args.config.exists() else ''
    base, previous = extract(original)
    config = tomllib.loads(base)
    if args.mode == 'status':
        print(json.dumps(previous or {'enabled': False, 'targets': []}, indent=2))
        return
    if args.mode == 'off' and not previous:
        print('Already off; no configuration changed.')
        return
    if previous and args.mode == 'off':
        targets = previous['targets']
    else:
        slack_id, gmail_id = args.slack_app_id, args.gmail_app_id
        if previous and not slack_id and not gmail_id:
            for target in previous['targets']:
                keys = target['path']
                if len(keys) == 5 and keys[0] == 'apps' and keys[2] == 'tools':
                    if keys[3].startswith('slack_'):
                        slack_id = keys[1]
                    elif keys[3] in ['send_email', 'send_draft', 'forward_emails', 'create_draft', 'update_draft']:
                        gmail_id = keys[1]
        targets = build_targets(config, slack_id, gmail_id)
    updated = base + ('' if not base or base.endswith('\n') else '\n') + render(targets, args.mode == 'on')
    tomllib.loads(updated)  # Reject conflicting tables before touching user config.
    args.config.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile('w', dir=args.config.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())
        if (args.config.read_text() if args.config.exists() else '') != original:
            raise ValueError('Config changed concurrently; no changes applied. Retry after reviewing it.')
        os.replace(temporary, args.config)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)
    print('Final-send confirmations ' + args.mode + '. Draft/read preparation stays available; unrelated settings are unchanged. No messages sent.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit(str(error))
