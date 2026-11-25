use aerift_remote_wan::{SecretKey, WanEndpoint, WanRoute};
use std::{collections::HashSet, io, net::SocketAddr, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn endpoint(seed: u8) -> WanEndpoint {
    WanEndpoint::bind(
        SecretKey::from_bytes(&[seed; 32]),
        Some("127.0.0.1:0".parse().unwrap()),
        None,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn explicit_private_route_transports_stream_between_pinned_endpoints() {
    let receiver = endpoint(1).await;
    let sender = endpoint(2).await;
    let route = sender
        .configured_route(receiver.id(), &receiver.bound_addresses())
        .unwrap();
    assert!(sender.configured_route(receiver.id(), &[]).is_err());
    let allowed = HashSet::from([sender.id()]);

    let send = async {
        let mut stream = sender.open(&route).await.unwrap();
        AsyncWriteExt::write_all(&mut stream, b"opaque payload example")
            .await
            .unwrap();
        let mut ack = [0u8; 3];
        AsyncReadExt::read_exact(&mut stream, &mut ack)
            .await
            .unwrap();
        assert_eq!(&ack, b"ack");
    };
    let receive = async {
        let (id, mut stream) = receiver.accept(&allowed).await.unwrap();
        assert_eq!(id, sender.id());
        let mut contents = [0u8; 22];
        AsyncReadExt::read_exact(&mut stream, &mut contents)
            .await
            .unwrap();
        assert_eq!(&contents, b"opaque payload example");
        AsyncWriteExt::write_all(&mut stream, b"ack").await.unwrap();
        AsyncWriteExt::shutdown(&mut stream).await.unwrap();
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(send, receive);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn unlisted_identity_never_gets_an_application_stream() {
    let receiver = endpoint(1).await;
    let sender = endpoint(2).await;
    let route = WanRoute::new(receiver.id(), &receiver.bound_addresses(), None).unwrap();
    let allowed = HashSet::from([SecretKey::from_bytes(&[3; 32]).public()]);
    let receiver = async {
        assert!(
            matches!(receiver.accept(&allowed).await, Err(ref e) if e.kind() == io::ErrorKind::PermissionDenied)
        );
    };
    let sender = async {
        let _ = sender.open(&route).await;
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(sender, receiver);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn no_route_and_unconfigured_relays_fail_before_connecting() {
    let id = SecretKey::from_bytes(&[1; 32]).public();
    assert!(WanRoute::new(id, &[], None).is_err());
    let bad: SocketAddr = "0.0.0.0:55".parse().unwrap();
    assert!(WanRoute::new(id, &[bad], None).is_err());
    let endpoint = endpoint(2).await;
    let relay = "https://self-hosted.example.invalid/".parse().unwrap();
    let route = WanRoute::new(id, &[], Some(relay)).unwrap();
    assert!(
        matches!(endpoint.open(&route).await, Err(ref e) if e.kind() == io::ErrorKind::PermissionDenied)
    );
}
