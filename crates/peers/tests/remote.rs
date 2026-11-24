use aerift_peers::RemotePeerNode;

#[test]
fn remote_has_no_nearby_discovery_or_legacy_invitation_input() {
    let local_code = format!("aerift:v1:{}:{}", "0".repeat(64), "A".repeat(43));
    assert!(RemotePeerNode::invitation_peer(&local_code).is_err());
}
