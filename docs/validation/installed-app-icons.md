# Installed AeRift app icons

The transparent native mark `assets/branding/aerift-mark-transparent.png`
is pinned at SHA-256
`3472bb0e7f7fa5911509f499fbe27a1ae8a2dc70767c48a64d69273799d388f3`.
Windows and iOS derive from this exact mark using deterministic,
alpha-weighted integer area sampling. The original opaque branding PNG
is unchanged and remains the Android launcher source.

- **Windows:** the checked-in ICO provides 16, 24, 32, 48 and 256 px entries;
  small frames retain BGRA alpha and a legacy AND mask. The default window
  PNG is also RGBA. Tauri and NSIS retain their existing paths for the
  application and installer. The isolated shell smoke compares expected
  icon colors and alpha against both executables. It does not observe icon
  caches or a personal desktop tray.
- **iOS:** simulator and device archive preparation produce the same
  universal 1024×1024 RGB AppIcon in the existing catalog. The full mark
  is centered in an 896 px inner square on the existing cool near-black
  `#04040b` backdrop, with 64 px of additional margin per edge. The OS
  supplies its own mask. The transparent mark itself is not submitted as
  the flat iOS AppIcon. Simulator smoke checks the compiled primary icon
  name and file references. Signed validation and a physical Home Screen
  remain separate gates.
- **Android:** the launcher preparation still uses the original approved
  opaque artwork (SHA-256
  `2aa3948cead24d7afeb23d9b417943ef869bcaf776f2e5182eeb97161fe7476f`).
  Adaptive/legacy variants, manifest checks and mask safety are unchanged.

Regenerate Windows inputs with `python3 scripts/branding/app-icons.py windows apps/aerift/src-tauri/icons`.
Run `python3 scripts/branding/test-app-icons.py` for source identity,
derivatives, Windows transparency masks, iOS RGB margin and Android legacy
and adaptive art. These are local source/asset tests, not installed app or
store qualification.
