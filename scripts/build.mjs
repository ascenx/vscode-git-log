import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const production = !watch;

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
};

const builds = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: ['src/editor/HistorySyntaxWorker.ts'],
    outfile: 'dist/history-syntax-worker.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    minify: production,
  },
  {
    ...shared,
    entryPoints: ['webview/src/index.tsx'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: ['es2022'],
    minify: production,
    define: {
      'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
    },
    loader: {
      '.svg': 'dataurl',
    },
  },
  {
    ...shared,
    entryPoints: ['test/integration/index.ts'],
    outfile: 'dist-test/integration.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => context(options)));
  await Promise.all(contexts.map((buildContext) => buildContext.watch()));
  console.log('Watching extension, webview, and integration tests...');
} else {
  await Promise.all(builds.map((options) => build(options)));
}
