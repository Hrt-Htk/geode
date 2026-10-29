# Vendored skill: do not edit in place

Source: https://github.com/gapmiss/obsidian-plugin-skill (MIT)
Upstream commit: 1a18a09
Skill: `obsidian`, general Obsidian plugin dev + UI-lint rules (eslint-plugin-obsidianmd v0.4.1).

This is a **third-party skill vendored unmodified** so it can be refreshed from upstream cleanly.
Do not edit these files with Geode-specific content: that goes in the `geode-ui` skill, which
defers here for generic rules and adds Geode's verification loop + mobile/Capacitor + native-fidelity
layers. To update: re-copy from a fresh clone of the upstream repo and bump the commit above.

Dash gate: the vendored bodies keep upstream's punctuation, so `scripts/check-dashes.ts` exempts
this directory. That is the only exemption in the gate.
