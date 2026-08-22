# Contributing

## Development

1. Install Node.js 22 and Git 2.27 or newer.
2. Run `npm install`.
3. Run `npm run watch` and launch the `Run Extension` configuration from VS Code.

## Required checks

Before proposing a change, run:

```text
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build
```

Features and bug fixes must follow test-driven development. Git behaviors should be tested against temporary fixture repositories rather than the contributor's working repository.

Do not add third-party proprietary source code, icons, logos, or other restricted assets. Use original implementation and Visual Studio Code-native UI.
