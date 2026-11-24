# Phase 1 verification

The local validation used Antigravity App 2.34.0, agy CLI 1.5.16, and Antigravity's bundled Node.js v24.22.0.

| Check | Result |
| --- | --- |
| Automated tests | Two project-root tests and one MCP stdio smoke test passed. |
| Strict plugin validation | The original demo and a clean copy both passed with Node on the CLI PATH. |
| Original workspace | The desktop sidebar opened and returned `workbench-ok` with the original demo directory. |
| Clean copy | The desktop sidebar returned `workbench-ok` with the copy's directory after refreshing the MCP service and starting a conversation turn in the copy. |

Antigravity 2.34.0 initially reused the original workspace's MCP process when the clean copy was open. Before relying on the sidebar in a second workspace, confirm that the reported directory belongs to that workspace.

Phase 1 covers plugin loading and connectivity. Acceptance-check execution and stale-result detection belong to later phases.
