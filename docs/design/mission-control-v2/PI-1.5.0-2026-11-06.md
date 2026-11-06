# Pi 1.5.0 compatibility and source update — 2026-11-06

This update moves the repository's tested Pi baseline from 1.4.0 to the official
Pi 1.5.0 release while keeping the package compatible with Pi 1.4.x and later
1.x hosts. The peer ranges remain `^1.4.0`, and the host guard still accepts
`>=1.4.0 <2`.

Pi 1.5.0 changes tool argument validation to `@earendil-works/pi-schema` and
removes validation support for several TypeBox-only constructs. Starhelm uses
ordinary JSON Schema-compatible schemas, so no runtime schema change was
needed. The release also improves large streamed tool arguments and TUI
rendering, adds extension update notices, bounds `pi.exec` output and timeout
handling, and fixes active-tool ordering and several TUI/clipboard cases.

The repository now contains an untouched upstream source snapshot at
`vendor/pi-1.5.0/`. Its identity is recorded in `vendor/pi-source.json`:

- tag: `v1.5.0`
- commit: `f9a26365568127461c47a07a37dcb42c140a3ac5`
- archive SHA-256: `1015146ce05a9219a0256861013633b10609668c6d14187fc8f47f540befaea3`
- normalized source-tree SHA-256: `c3a41122b1f5b3102d1bc7ec91bb4e7ddeda88309153ae92b023a37241e73fe6`
- 2,949 regular files, 34,603,541 source bytes

The old `vendor/pi-1.4.0/` checkout was removed from the current tree; its
history remains available in Git. The lock file and CI matrix now use Pi 1.5.0
and include the new `pi-schema` package. The plugin's dependency lookup now
resolves from the selected Pi host's Node lookup roots, so both nested npm
installs and hoisted prefix installs work. This fixes the test harness without
changing the plugin's runtime compatibility floor.

The first isolated WSL 1.5.0 run exposed a test-layout assumption: the harness
expected every host dependency below `hostDir/node_modules`, while the isolated
official npm install hoisted several packages to its prefix. That run was
discarded as a harness failure. After the resolver and tests were corrected, the
same install passed without temporary dependency links.

Validation completed against the candidate checkout:

- Windows 11, Node 24.16.0, global Pi 1.5.0: `443` tests, `438` passed, `5`
  skipped, `0` failed; typecheck covered `52` source files.
- WSL Debian, Node 22.23.3, isolated Pi 1.5.0: `443` tests, `436` passed, `7`
  skipped, `0` failed; source identity check and typecheck both returned 0.
- Dedicated WSL conversation `插件回归测试（WSL）`: candidate loaded through
  literal `/reload` in the same Pi process; manual recovery reported `282`
  checks and portable transfer reported `288` checks, both passed.

The Windows host was upgraded with the official `@earendil-works/pi-coding-agent`
1.5.0 package. The plugin was installed into the normal Pi package location.
Pi's existing junction-backed `./packages/pi-mission-control` registration was
preserved; the duplicate path created by the installer was removed. No
production conversation was opened, reloaded, stopped, or sent a test prompt.

The running Pi process must be exited and started again to use the new host
binary. Plugin `/reload` is sufficient for plugin source changes, but it cannot
replace an already-running 1.4.0 host process.
