import { resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

const extensionDevelopmentPath = resolve(import.meta.dirname, '..');
const extensionTestsPath = resolve(extensionDevelopmentPath, 'dist-test', 'integration.js');
const version = process.env.VSCODE_TEST_VERSION ?? '1.85.2';

try {
  await runTests({
    version,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [resolve(extensionDevelopmentPath, 'test', 'fixtures', 'empty-workspace')],
  });
} catch (error) {
  console.error('VS Code integration tests failed.', error);
  process.exitCode = 1;
}
