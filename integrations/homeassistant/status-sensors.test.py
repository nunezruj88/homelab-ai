import json
import unittest
from pathlib import Path
from datetime import datetime, timezone
import yaml
from jinja2.sandbox import SandboxedEnvironment

ROOT = Path(__file__).parent
sensors = yaml.safe_load((ROOT / 'status-sensors.yaml').read_text(encoding='utf-8'))[0]['sensor']
def from_json(value, default=None):
    try: return json.loads(value)
    except (ValueError, TypeError): return default
def timestamp(value, default=None):
    if isinstance(value, datetime): return value.timestamp()
    try: return datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
    except (ValueError, TypeError, AttributeError): return default

class StatusTests(unittest.TestCase):
    def render(self, report, generated='2026-09-21T08:00:00Z', latest='ok', source_state='2026-09-21T08:00:00Z', now='2026-09-21T09:00:00Z'):
        attrs={'report':report,'generated_at':generated,'last_run_status':latest}
        env=SandboxedEnvironment()
        env.filters['from_json']=from_json
        env.globals.update(state_attr=lambda e,k:attrs.get(k),states=lambda e:source_state,
            now=lambda:datetime.fromisoformat(now.replace('Z','+00:00')),as_timestamp=timestamp)
        return [env.from_string(s['state']).render().strip() for s in sensors]
    def report(self,state='ok',stamp='2026-09-21T08:00:00Z'):
        return '<!-- HOMELAB_STATUS_V1\n'+json.dumps({'schema':1,'generated_at':stamp,
            'systems':{s:{'state':state} for s in ['proxmox','homeassistant','truenas','homelab']}})+'\nEND_HOMELAB_STATUS -->'
    def test_fresh_and_expired(self):
        self.assertEqual(self.render(self.report()),['ok']*4)
        self.assertEqual(self.render(self.report(),now='2026-09-22T14:01:00Z'),['unknown']*4)
        self.assertEqual(self.render(self.report('critical')),['critical']*4)
    def test_failed_run_missing_future_and_mismatched_dates(self):
        for kwargs in [{'latest':'error'},{'latest':'skipped'},{'source_state':'unavailable'},
                       {'generated':None},{'now':'2026-09-21T07:00:00Z'},
                       {'generated':'2026-09-21T08:01:00Z'}]:
            self.assertEqual(self.render(self.report(),**kwargs),['unknown']*4)
    def test_malformed_and_old_reports(self):
        for report in ['old report','<!-- HOMELAB_STATUS_V1\nbad\nEND_HOMELAB_STATUS -->',
                       '<!-- HOMELAB_STATUS_V1\n[]\nEND_HOMELAB_STATUS -->']:
            self.assertEqual(self.render(report),['unknown']*4)
    def test_ids_and_cards(self):
        self.assertEqual(len(sensors),4)
        self.assertEqual(len({s['unique_id'] for s in sensors}),4)
        cards=yaml.safe_load((ROOT/'status-cards.yaml').read_text(encoding='utf-8'))
        self.assertEqual(cards['type'],'vertical-stack')
        self.assertEqual(len(cards['cards']),5)
if __name__ == '__main__':
    unittest.main()
