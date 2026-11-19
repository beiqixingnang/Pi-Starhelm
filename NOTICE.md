# Attribution

Pi Starhelm combines local extensions developed for this project with code adapted from the MIT-licensed Pi project and its extension examples, including the subagent example and custom compaction patterns.

Upstream: https://github.com/earendil-works/pi

Pi and its host-provided libraries remain separate runtime installations. Runtime libraries are declared as peer dependencies and resolved by the Pi extension loader; published npm packages and their installed dependencies are not bundled into the plugin package.

The Git repository contains an unmodified Pi source snapshot at `vendor/pi-1.5.2/` from upstream tag v1.5.2. Its original MIT license and copyright notice are retained in `vendor/pi-1.5.2/LICENSE` (Copyright (c) 2025 Mario Zechner). See `vendor/README.md` and `vendor/pi-source.json` for the current archive identity and checksum. The snapshot is excluded from the plugin's npm package and does not replace the installed Pi runtime. The older v1.5.0 source snapshot was removed from the current tree; its historical compatibility record remains in the documentation.

The archive exporter depends on `stream-json` and its transitive dependency `stream-chain`, by Eugene Lazutkin, under their BSD-3-Clause licenses. They are installed as ordinary npm dependencies; their own distributions retain their original copyright and license notices.
