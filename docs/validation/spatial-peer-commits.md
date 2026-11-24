# Spatial peer commit measurement

Compare the candidate with the baseline `e8cab6efff8e4f100ff582b2ef7d945de3fcd64e` using the repository's React DOM 19.2.0 and a disposable jsdom 31.0.1 install. No production or test dependency is added to the repo.

```sh
scratch="$(mktemp -d)"
npm install --prefix "$scratch" --no-save --ignore-scripts jsdom@31.0.1
AERIFT_JSDOM_MODULE="$scratch/node_modules/jsdom/lib/api.js" \
  node scripts/measure-spatial-peer-commits.mjs e8cab6ef
```

The script counts a test-only layout effect after each committed Peer render, not speculative render calls. Six real peer tiles are mounted; the harness commits 120 updates to the sibling progress output and recreates the six snapshot Device objects on every update. A subsequent frame changes one peer's selection and active states.

| Phase | Baseline peer commits | Candidate peer commits |
| --- | ---: | ---: |
| Six peers mount | 6 | 6 |
| 120 progress updates with unchanged device values | 720 | 0 |
| Select and activate one peer | 6 | 1 |

The fixture checks that the progress output reaches frame 120, and that selection, identity, online state, disabled state, and changed click handlers are still reflected. Use `npm run test:ui` for the ordinary UI suite and fixture build. No browser frame-rate, React root commit, native snapshot frequency, CPU or GPU savings are implied by the measured peer-subtree counts. The Rift overlay/anchors and status can still update: the boundary is on peer tiles only. Actual animation and physical WebView rendering remain separate.
