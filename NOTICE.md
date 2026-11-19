# Attribution

Pi Starhelm combines local extensions developed for this project with code adapted from the MIT-licensed Pi project and its extension examples, including the subagent example and custom compaction patterns.

Upstream: https://github.com/earendil-works/pi

Pi and its host-provided libraries remain separate runtime installations. Runtime libraries are declared as peer dependencies and resolved by the Pi extension loader; published npm packages and their installed dependencies are not bundled into the plugin package.

The Git repository also contains unmodified Pi source snapshots under `vendor/pi-1.5.0/` and `vendor/pi-1.5.2/`, from upstream tags v1.5.0 and v1.5.2. Their original MIT licenses and copyright notices are retained in each snapshot's `LICENSE` file (Copyright (c) 2025 Mario Zechner). See `vendor/README.md` and `vendor/pi-source.json` for the current archive identity and checksum. These source snapshots are excluded from the plugin's npm package and do not replace the installed Pi runtime.

The archive exporter depends on `stream-json` and its transitive dependency `stream-chain`, by Eugene Lazutkin, under their BSD-3-Clause licenses. They are installed as ordinary npm dependencies; their own distributions retain their original copyright and license notices.
