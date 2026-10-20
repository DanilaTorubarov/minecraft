"""Exercise isolation and failure propagation without Docker or real services."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class EconomySimulationRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'project with spaces'
        (self.root / 'scripts').mkdir(parents=True)
        shutil.copy(Path(__file__).parents[1] / 'simulate-economy.sh', self.root / 'scripts')
        (self.root / '.env.docker').write_text('THIS_MUST_NOT_BE_LOADED=production-secret')
        self.bin = Path(self.temp.name) / 'bin'
        self.bin.mkdir()
        self.log = Path(self.temp.name) / 'calls.json'
        fake = self.bin / 'docker'
        fake.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
Path(os.environ['SIM_CALL_LOG']).write_text(json.dumps({
    'args': sys.argv[1:], 'cwd': os.getcwd(),
    'strict': os.environ.get('ECONOMY_SIM_STRICT')}))
Path('reports/economy').mkdir(parents=True, exist_ok=True)
Path('reports/economy/acceptance.json').write_text('{"passed":false}')
sys.exit(int(os.environ.get('SIM_EXIT', '0')))
''')
        fake.chmod(0o755)

    def run_script(self, *args, exit_code=0):
        return subprocess.run(['sh', str(self.root / 'scripts/simulate-economy.sh'), *args],
                              cwd=self.bin, env=dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                              SIM_CALL_LOG=str(self.log), SIM_EXIT=str(exit_code)),
                              capture_output=True, text=True)

    def test_report_mode_has_no_production_env_or_dependencies(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads(self.log.read_text())
        self.assertEqual(Path(call['cwd']).resolve(), self.root.resolve())
        self.assertEqual(call['strict'], '0')
        self.assertEqual(call['args'], ['compose', '-p', 'oasis-economy-sim', '-f',
                         'compose.economy-sim.yaml', 'run', '--rm', '--no-deps', 'simulation'])

    def test_strict_failure_is_preserved_with_its_report(self):
        result = self.run_script('--strict', exit_code=101)
        self.assertEqual(result.returncode, 101)
        self.assertEqual(json.loads(self.log.read_text())['strict'], '1')
        self.assertEqual(json.loads((self.root / 'reports/economy/acceptance.json').read_text()),
                         {'passed': False})

    def test_invalid_arguments_do_not_call_docker(self):
        for args in [('--deploy',), ('--strict', 'extra')]:
            with self.subTest(args=args):
                self.assertEqual(self.run_script(*args).returncode, 2)
                self.assertFalse(self.log.exists())
