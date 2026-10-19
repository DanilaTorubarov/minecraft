"""Reject damaged executables without touching an installed server or using Docker."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class LocalPurpurTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        scripts = self.root / 'scripts'
        scripts.mkdir()
        for name in ('verify-purpur.sh', 'install-local-purpur.sh'):
            shutil.copy2(Path(__file__).parents[1] / name, scripts / name)

    def run_script(self, name, *args, **env):
        return subprocess.run(
            ['sh', str(self.root / 'scripts' / name), *map(str, args)],
            env=dict(os.environ, **env), capture_output=True, text=True)

    def test_corrupt_source_preserves_existing_installation(self):
        installed = self.root / 'mc/server-jars/purpur-26.3-2652.jar'
        installed.parent.mkdir(parents=True)
        installed.write_bytes(b'existing executable must survive')
        corrupt = self.root / 'partial.jar'
        corrupt.write_bytes(b'PK interrupted transfer')
        result = self.run_script('install-local-purpur.sh', corrupt)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum mismatch', result.stderr)
        self.assertEqual(installed.read_bytes(), b'existing executable must survive')
        self.assertEqual(list(installed.parent.iterdir()), [installed])

    def test_missing_source_does_not_create_runtime_directory(self):
        result = self.run_script('install-local-purpur.sh', self.root / 'missing.jar')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'mc').exists())

    def test_prestart_rejects_corrupt_custom_server(self):
        corrupt = self.root / 'server.jar'
        corrupt.write_bytes(b'not a server executable')
        result = self.run_script('verify-purpur.sh', CUSTOM_SERVER=str(corrupt))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum mismatch', result.stderr)
        self.assertEqual(corrupt.read_bytes(), b'not a server executable')


if __name__ == '__main__':
    unittest.main()
