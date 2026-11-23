use std::time::Duration;

use aerift_peers::{Device, Discovery, Platform};
use aerift_transfer::PeerId;

#[tokio::test]
#[ignore = "requires multicast networking on a reachable LAN interface"]
async fn multicast_advertise_resolve_and_remove() {
    let a = Device {
        id: PeerId::from_tls_leaf(b"discovery a"),
        name: "AeRift discovery A".to_owned(),
        platform: Platform::Windows,
    };
    let b = Device {
        id: PeerId::from_tls_leaf(b"discovery b"),
        name: "AeRift discovery B".to_owned(),
        platform: Platform::Ios,
    };
    let mut browse = Discovery::start(&a, 48121).unwrap();
    let advertise = Discovery::start(&b, 48122).unwrap();
    let peer = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Some(peer) = browse
                .changed()
                .await
                .unwrap()
                .into_iter()
                .find(|peer| peer.device.id == b.id)
            {
                break peer;
            }
        }
    })
    .await
    .expect("no matching DNS-SD advertisement");
    assert_eq!(peer.device, b);
    assert!(
        peer.endpoints
            .iter()
            .all(|endpoint| endpoint.port() == 48122)
    );
    assert!(!browse.snapshot().iter().any(|peer| peer.device.id == a.id));
    advertise.stop().await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while browse
            .changed()
            .await
            .unwrap()
            .iter()
            .any(|peer| peer.device.id == b.id)
        {}
    })
    .await
    .expect("no matching DNS-SD goodbye");
}
