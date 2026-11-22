# Contributing

Use Node.js 22 or newer and Python 3.11 or newer. Keep all examples generic and
all personal state outside the repository.

The public product and repository name is `open-AICC`. Keep the `aicc` command,
`AICC_` environment prefix, and `~/.ai-control-center` state path compatible.
Do not add a second personal fork layer or commit owner overlays into this repository.

```bash
npm run check
npm run test:distribution
npm test
npm run smoke
npm run test:account-manager
```

Do not run live account switching or provider stop commands as part of tests.
Use fixture homes and fake command runners for state-changing behavior.
