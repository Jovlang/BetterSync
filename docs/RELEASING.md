# Release preparation

1. Complete and record docs/ACCEPTANCE.md on real desktop, MacBook and iPhone clients. Validate Obsidian 1.8.7 or raise manifest.minAppVersion to the oldest verified version. Automated tests do not satisfy this gate.
2. Run npm ci and npm run verify, then npm run test:integration against an isolated CouchDB 3.5 server as configured in CI. Never use a vault database.
3. Keep manifest.json and package.json versions aligned. Verify the repository is publicly accessible before community submission.
4. Create a GitHub Release whose tag exactly matches manifest.version (currently 0.1.0). Attach main.js, manifest.json, LICENSE and THIRD_PARTY_NOTICES.md. No styles.css is currently used. Provide the exact corresponding source through the release tag; preserve GPLv3 and bundled MIT notices when redistributing.
5. Follow the current official Obsidian submission instructions: https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin . The submission portal and current review process must be confirmed before submission.

This checklist does not authorize publication or claim device acceptance. The code is GPL-3.0-only; see LICENSE.
