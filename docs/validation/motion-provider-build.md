# AeRift motion provider: public and local assembly

The public checkout requires no account, key, private Git remote, or private
package. Its standard commands and public checks use the shipped provider.
The public motion layer still owns hit targets, reduced-motion behavior,
navigation state, transfers, and authorization. The v1 provider changes a
small set of bounded Workspace card spring and inner-symbol values; it cannot
register callbacks or inject components, CSS, shaders, or remote requests.

## Local synthetic rehearsal

From a clean public checkout, run the existing app build without environment
overrides to exercise the public baseline. To exercise local assembly with
synthetic data, put this JSON in a normal file outside the public checkout:

```json
{"version":1,"workspaceCard":{"settle":{"stiffness":491.123,"damping":44,"mass":0.61},"push":{"stiffness":429,"damping":26,"mass":0.54},"symbol":{"hoverScale":1.11,"hoverY":-4,"pressScale":0.94},"chevron":{"hoverX":5,"pressX":2}}}
```

On PowerShell:

```powershell
$env:AERIFT_MOTION_PROFILE = "premium"
$env:AERIFT_MOTION_PROVIDER = (Resolve-Path "..\reviewed-fixtures\motion.json").Path
npm --workspace apps/aerift run build
Remove-Item Env:AERIFT_MOTION_PROFILE, Env:AERIFT_MOTION_PROVIDER
```

Use equivalent environment assignments on POSIX shells. Use an isolated
checkout for premium builds so the output cannot be mistaken for public output.
Never copy a premium dist, screenshots, maps, logs, source, or provider
configuration into public Git or public CI. The build supports loopback-only
development, does not accept an authentication key, refuses premium mode in
public CI, and fails rather than substituting public data when the requested
provider is missing, unreadable, or incompatible. The manifest path is not
bundled. No source maps are generated in premium mode.

V1 is not a sandbox for arbitrary React code or a complete premium provider.
Expansion to components/shaders and actual licensed material requires separate
contract and custody review, final artifact inspection, and local platform
qualification. Keep premium checks informational to public PRs until their
reliability and authorization have been explicitly evaluated. Do not register
a public Actions runner on the development machine.
