"""Export regression tests with a fake Docker CLI; no live services are stopped."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.project = self.base / 'project'
        (self.project / 'scripts').mkdir(parents=True)
        shutil.copy(Path(__file__).parents[1] / 'export.sh', self.project / 'scripts/export.sh')
        (self.project / 'compose.yaml').write_text('services: {}')
        (self.project / '.env.docker').write_text('TEST_ONLY=1')
        (self.project / 'world.dat').write_text('saved world')
        (self.project / 'project-export-old.tar.gz').write_text('previous backup')
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        docker = self.bin / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['COMMAND_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if args[0] == 'inspect':
    print(os.environ.get('STOP_CODE', '143'))
elif 'ps' in args:
    if '--quiet' in args: print('test-container')
    else: print(os.environ.get('RUNNING', 'app\\nvelocity\\npurpur\\ndb'))
elif 'exec' in args:
    if os.environ.get('FAIL_DUMP'): sys.exit(17)
    print('-- test database dump')
''')
        docker.chmod(0o755)
        self.log = self.base / 'commands.jsonl'
        self.out = self.project / 'result.tar.gz'

    def run_export(self, **settings):
        env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                   COMMAND_LOG=str(self.log), **settings)
        result = subprocess.run(['sh', str(self.project / 'scripts/export.sh'), str(self.out)],
                                cwd=self.base, env=env, capture_output=True, text=True)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return result, calls

    def test_snapshot_and_restart_only_previously_running_services(self):
        result, calls = self.run_export(RUNNING='purpur\ndb')
        self.assertEqual(result.returncode, 0, result.stderr)
        stop = next(i for i, call in enumerate(calls) if 'stop' in call)
        dump = next(i for i, call in enumerate(calls) if 'exec' in call)
        start = next(i for i, call in enumerate(calls) if 'start' in call)
        self.assertLess(stop, dump)
        self.assertLess(dump, start)
        self.assertEqual(calls[start][-2:], ['start', 'purpur'])
        with tarfile.open(self.out) as archive:
            names = archive.getnames()
            self.assertIn('./world.dat', names)
            self.assertIn('db.sql', names)
            self.assertFalse(any(name.endswith('.tar.gz') for name in names))

    def test_dump_failure_restarts_services_and_publishes_no_archive(self):
        result, calls = self.run_export(FAIL_DUMP='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any('start' in call for call in calls))
        self.assertFalse(self.out.exists())

    def test_forced_shutdown_rejects_snapshot_and_restarts(self):
        result, calls = self.run_export(STOP_CODE='137')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('exec' in call for call in calls))
        self.assertTrue(any('start' in call for call in calls))
        self.assertFalse(self.out.exists())

    def test_already_stopped_stack_is_not_started(self):
        result, calls = self.run_export(RUNNING='db')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any('stop' in call or 'start' in call for call in calls))


if __name__ == '__main__':
    unittest.main()
