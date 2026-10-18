"""Deployment failure checks with fake tools; no live services are touched."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.project = self.base / 'project'
        (self.project / '.git').mkdir(parents=True)
        (self.project / 'scripts').mkdir()
        (self.project / '.env.docker').write_text('TEST_ONLY=1')
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.log = self.base / 'commands.jsonl'
        self.sha = 'a' * 40
        tool = '''#!/usr/bin/env python3
import json, os, sys
name = os.path.basename(sys.argv[0])
args = sys.argv[1:]
with open(os.environ['COMMAND_LOG'], 'a') as log:
    log.write(json.dumps([name] + args) + '\\n')
if name == 'git':
    if args[0] == 'status': print(os.environ.get('DIRTY', ''))
    if args[0] == 'rev-parse': print(os.environ['CHECKOUT_SHA'])
    if args[0] == 'merge-base' and os.environ.get('UNTRUSTED'): sys.exit(1)
if name == 'docker' and 'build' in args and os.environ.get('FAIL_BUILD'):
    sys.exit(17)
'''
        for name in ['git', 'docker', 'flock']:
            path = self.bin / name
            path.write_text(tool)
            path.chmod(0o755)
        plugin = self.project / 'scripts/build-plugin.sh'
        plugin.write_text(tool)
        plugin.chmod(0o755)

    def deploy(self, sha=None, **settings):
        env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                   COMMAND_LOG=str(self.log), CHECKOUT_SHA=self.sha)
        env.update(settings)
        result = subprocess.run(
            ['bash', str(Path(__file__).parents[1] / 'deploy.sh'),
             str(self.project), sha if sha is not None else self.sha],
            env=env, text=True, capture_output=True)
        calls = ([json.loads(line) for line in self.log.read_text().splitlines()]
                 if self.log.exists() else [])
        return result, calls

    def test_deploys_tested_commit_and_builds_before_restarting(self):
        result, calls = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(['git', 'merge', '--ff-only', self.sha], calls)
        plugin = next(i for i, call in enumerate(calls) if call[0] == 'build-plugin.sh')
        build = next(i for i, call in enumerate(calls) if call[-2:] == ['build', 'app'])
        up = next(i for i, call in enumerate(calls) if 'up' in call)
        restart = next(i for i, call in enumerate(calls) if call[-2:] == ['restart', 'purpur'])
        self.assertLess(build, up)
        self.assertLess(plugin, up)
        self.assertLess(up, restart)

    def test_build_failure_leaves_running_services_alone(self):
        result, calls = self.deploy(FAIL_BUILD='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('up' in call or 'restart' in call for call in calls))

    def test_dirty_checkout_is_rejected_before_git_mutation(self):
        result, calls = self.deploy(DIRTY=' M compose.yaml')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('fetch' in call or call[0] == 'docker' for call in calls))

    def test_checkout_ahead_of_requested_commit_is_not_deployed(self):
        result, calls = self.deploy(CHECKOUT_SHA='b' * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[0] == 'docker' for call in calls))

    def test_commit_outside_main_is_rejected(self):
        result, calls = self.deploy(UNTRUSTED='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('switch' in call or call[0] == 'docker' for call in calls))

    def test_invalid_commit_argument_is_rejected_before_commands(self):
        result, calls = self.deploy(sha='main; echo invalid')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
