# AeRift foundations integration

This integrates exactly the following pull-request heads on `85026413c232d2de076b89a9000a6f6d182c7477`; stack parents are incorporated once. It does not activate experimental features, publish an app, or assert physical transfer/camera qualification.

| Track | Pull requests | Shipping/qualification boundary |
| --- | --- | --- |
| Android | #57 | Build and smoke-tested mobile port, still separate from signing, app-store assignment and device/physical qualification. |
| Nearby | #59 | Discovery-bound six-digit explicit pair verification. Desktop, iOS and Android use the scoped Nearby endpoint; approval and trust are independent of Remote/Friends. |
| Remote | #58, #60, #62, #64, #66, #67, #72 | Private invitations and resume components; forced loopback relay qualification; Windows developer-only receiver and standalone qualifier. No default Remote product activation. No real distinct-uplink proof, and Unix checkpoint journal is not a Windows persistence claim. |
| Friends | #61, #63, #70 | Private explicit grants, offer and winning-target payload proofs. The ordinary app does not advertise or activate a Friends capability. |
| Ambient | #65, #68, #69, #71 | Explicit Windows capture and Nearby-only single-file sending. Capture/camera controls fail closed; native qualification does not open a physical camera. No default runtime camera, automated background gestures, physical Explorer focus or driver release claim. |

The experimental combined folder prototype is not part of this tree. Network qualification uses generated local identities and fixture files. Camera model qualification uses fixed upstream inputs and never enables physical capture.

Conflict resolution preserves the shared mobile shell and platform-specific storage, adds Nearby verification to the Android listener with native discovery readiness and source screening, keeps dedicated Remote and Friends lanes, and uses the same v1 upload path for both live Friends authorization checks and Ambient frozen-block integrity. Native Windows optional feature flags remain separate from normal startup.
