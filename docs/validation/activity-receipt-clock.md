# Activity: compatibility-preserving sealed Inbox time

The Activity clock uses a companion, authenticated display marker. The strict
v1 file remains unchanged and time never comes from filesystem modification:

1. Keep `verified.json` byte schema v1 and `deny_unknown_fields` unchanged.
2. Add one fixed app-owned optional time marker in the same receipt directory,
   sealed by the same host provider with a distinct format/domain tag. Its
   claims are peer, receipt UUID, offer SHA-256, byte length, local Unix-ms
   timestamp, and marker version. No user paths or payload bytes in the marker.
3. Write that derivative marker after verifying payload and before publishing
   the ordinary final receipt marker. A timestamp write failure may conservatively
   be treated as unavailable without misreporting transfer failure or exposing
   bytes. Clean up only this exact owned name on publication failure.
4. Browse only after validating the existing sealed receipt. Open the optional
   time marker with bounded read, check seal, fixed identity/length/digest,
   exact version, and Unix-ms date bounds. An absent, damaged, swapped or unknown
   marker means time unavailable; never disqualify the independently valid
   content receipt. The marker is never used for content authorization or open.
5. Older binaries ignore leaf names other than the existing payload/receipt.
   Validate every old recovery and cleanup path before assuming downgrade
   compatibility. Change the test seal mock to represent different opaque seal
   handles without logging actual data. Tests: old struct with strict schema can
   parse a newly written original marker; fresh reader recovers exact time from
   the companion; legacy, tampered, wrong-peer, wrong-UUID and wrong-digest time
   markers read as undated; payload still verifies. No schema permit relaxation.
