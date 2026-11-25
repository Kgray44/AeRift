//! Opt-in outer transport for an AeRift Remote TLS byte stream.
//!
//! An endpoint key authenticates routing, not AeRift application authorization.
//! Feed every accepted stream through the existing, independently pinned Remote
//! TLS lane before sending any invitation, metadata, or payload.
use std::{
    collections::HashSet,
    future::Future,
    io,
    net::SocketAddr,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use iroh::{
    Endpoint, EndpointAddr, RelayMode,
    endpoint::{Connection, RecvStream, SendStream, presets},
};
pub use iroh::{EndpointId, RelayUrl, SecretKey};
mod native_host;
mod qualification;
pub use native_host::{DeviceCard, OperatorRelay, WanSession};
pub use qualification::{QualificationAction, QualificationController, QualificationReply};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

const ALPN: &[u8] = b"aerift/remote/opaque-tls/1";
const HANDSHAKE_LIMIT: Duration = Duration::from_secs(10);
const MAX_DIRECT_ROUTES: usize = 4;

/// Deliberately exchanged route for a specific endpoint identity. No by-ID lookup.
/// Process this only through the local invitation/known-peer authorization path.
pub struct WanRoute {
    address: EndpointAddr,
    relay: Option<RelayUrl>,
}

impl WanRoute {
    pub fn new(id: EndpointId, direct: &[SocketAddr], relay: Option<RelayUrl>) -> io::Result<Self> {
        if direct.len() > MAX_DIRECT_ROUTES
            || (direct.is_empty() && relay.is_none())
            || direct.iter().any(|addr| {
                addr.port() == 0 || addr.ip().is_unspecified() || addr.ip().is_multicast()
            })
            || relay.as_ref().is_some_and(|url| !valid_relay(url))
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let mut address = EndpointAddr::new(id);
        for addr in direct {
            address = address.with_ip_addr(*addr);
        }
        if let Some(url) = &relay {
            address = address.with_relay_url(url.clone());
        }
        Ok(Self { address, relay })
    }
}

/// Inbound and outbound QUIC endpoint. Nothing is configured by default outside
/// the local sockets. The host supplies a persisted key from protected storage.
pub struct WanEndpoint {
    endpoint: Endpoint,
    relay: Option<RelayUrl>,
}

impl WanEndpoint {
    /// The relay option must come from a trusted local configuration, never an
    /// invitation or network input. Use only a private, operator-controlled relay.
    pub async fn bind(
        secret: SecretKey,
        bind: Option<SocketAddr>,
        relay: Option<RelayUrl>,
    ) -> io::Result<Self> {
        let builder = make_builder(secret, bind, relay.as_ref())?;
        let endpoint = builder
            .bind()
            .await
            .map_err(|_| io::ErrorKind::AddrNotAvailable)?;
        Ok(Self { endpoint, relay })
    }

    pub fn id(&self) -> EndpointId {
        self.endpoint.id()
    }

    /// Socket bindings, not discovered/NAT-mapped addresses. Do not publish them.
    pub fn bound_addresses(&self) -> Vec<SocketAddr> {
        self.endpoint.bound_sockets()
    }

    /// Construct a route to the authenticated peer key using only the relay
    /// set locally at bind time. Direct addresses, if supplied by the host,
    /// must come from a separately authenticated transport exchange.
    /// This method takes no relay URL and cannot enable a relay after startup.
    pub fn configured_route(
        &self,
        peer: EndpointId,
        direct: &[SocketAddr],
    ) -> io::Result<WanRoute> {
        WanRoute::new(peer, direct, self.relay.clone())
    }

    /// Do not trust an invitation to introduce a new relay. This gate runs
    /// before any network I/O for the route.
    pub async fn open(&self, route: &WanRoute) -> io::Result<WanStream> {
        if route
            .relay
            .as_ref()
            .is_some_and(|relay| self.relay.as_ref() != Some(relay))
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let future = async {
            let connection = self
                .endpoint
                .connect(route.address.clone(), ALPN)
                .await
                .map_err(|_| io::ErrorKind::NotConnected)?;
            let (send, recv) = connection
                .open_bi()
                .await
                .map_err(|_| io::ErrorKind::ConnectionAborted)?;
            Ok(WanStream {
                connection,
                send,
                shutdown: Shutdown::NotStarted,
                recv,
            })
        };
        tokio::time::timeout(HANDSHAKE_LIMIT, future)
            .await
            .map_err(|_| io::ErrorKind::TimedOut)?
    }

    /// Admit only explicitly allowed outer keys (from pending targeted invites
    /// or authorized Remote devices). The caller must apply live authorization
    /// and the existing inner Remote checks separately, including revocation.
    /// This is not cancellation-safe: it owns the connection while waiting
    /// for the first stream. Only cancel it when intentionally dropping that
    /// connection (for example, on endpoint shutdown).
    pub async fn accept(
        &self,
        allowed: &HashSet<EndpointId>,
    ) -> io::Result<(EndpointId, WanStream)> {
        self.accept_with(|peer| allowed.contains(&peer)).await
    }

    /// Check live host permission after the actual remote endpoint key has
    /// been authenticated. The host must recheck permission at inner dispatch.
    pub async fn accept_with(
        &self,
        permitted: impl FnOnce(EndpointId) -> bool,
    ) -> io::Result<(EndpointId, WanStream)> {
        let incoming = self
            .endpoint
            .accept()
            .await
            .ok_or(io::ErrorKind::NotConnected)?;
        let future = async {
            let connection = incoming
                .await
                .map_err(|_| io::ErrorKind::ConnectionAborted)?;
            let peer = connection.remote_id();
            if !permitted(peer) {
                connection.close(0u32.into(), b"");
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            let (send, recv) = connection
                .accept_bi()
                .await
                .map_err(|_| io::ErrorKind::ConnectionAborted)?;
            Ok((
                peer,
                WanStream {
                    connection,
                    send,
                    shutdown: Shutdown::NotStarted,
                    recv,
                },
            ))
        };
        tokio::time::timeout(HANDSHAKE_LIMIT, future)
            .await
            .map_err(|_| io::ErrorKind::TimedOut)?
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

fn make_builder(
    secret: SecretKey,
    bind: Option<SocketAddr>,
    relay: Option<&RelayUrl>,
) -> io::Result<iroh::endpoint::Builder> {
    if relay.is_some_and(|url| !valid_relay(url)) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mode = relay.map_or(RelayMode::Disabled, |url| RelayMode::custom([url.clone()]));
    let mut builder = Endpoint::builder(presets::Minimal)
        .clear_address_lookup()
        .relay_mode(mode)
        .secret_key(secret)
        .alpns(vec![ALPN.to_vec()]);
    if let Some(addr) = bind {
        builder = builder
            .clear_ip_transports()
            .bind_addr(addr)
            .map_err(|_| io::ErrorKind::InvalidInput)?;
    }
    Ok(builder)
}

fn valid_relay(url: &RelayUrl) -> bool {
    url.scheme() == "https"
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

/// One bounded-lifetime QUIC bidirectional stream. In AeRift, it transports
/// opaque Remote mTLS bytes; it never derives application authorization.
pub struct WanStream {
    connection: Connection,
    send: SendStream,
    shutdown: Shutdown,
    recv: RecvStream,
}

/// Selected transport path at the instant of the query, without addresses.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathKind {
    Direct,
    Relay,
}

impl WanStream {
    pub fn selected_path(&self) -> Option<PathKind> {
        self.connection
            .paths()
            .iter()
            .find(|path| path.is_selected())
            .map(|path| {
                if path.is_relay() {
                    PathKind::Relay
                } else {
                    PathKind::Direct
                }
            })
    }
}

type ShutdownWait = Pin<Box<dyn Future<Output = io::Result<()>> + Send + Sync>>;

enum Shutdown {
    NotStarted,
    Waiting(ShutdownWait),
    Done(Result<(), io::ErrorKind>),
}

impl AsyncRead for WanStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        data: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        AsyncRead::poll_read(Pin::new(&mut self.recv), context, data)
    }
}

impl AsyncWrite for WanStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        AsyncWrite::poll_write(Pin::new(&mut self.send), context, data)
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        AsyncWrite::poll_flush(Pin::new(&mut self.send), context)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        if matches!(self.shutdown, Shutdown::NotStarted) {
            if let Err(error) = self.send.finish() {
                return Poll::Ready(Err(error.into()));
            }
            let stopped = self.send.stopped();
            self.shutdown = Shutdown::Waiting(Box::pin(async move {
                match tokio::time::timeout(HANDSHAKE_LIMIT, stopped).await {
                    Ok(Ok(None)) => Ok(()),
                    Ok(_) => Err(io::ErrorKind::ConnectionAborted.into()),
                    Err(_) => Err(io::ErrorKind::TimedOut.into()),
                }
            }));
        }
        match &mut self.shutdown {
            Shutdown::Waiting(future) => {
                let Poll::Ready(result) = future.as_mut().poll(context) else {
                    return Poll::Pending;
                };
                self.shutdown =
                    Shutdown::Done(result.as_ref().map(|_| ()).map_err(io::Error::kind));
                Poll::Ready(result)
            }
            Shutdown::Done(result) => Poll::Ready(result.map_err(io::Error::from)),
            Shutdown::NotStarted => unreachable!("installed above"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh_relay::{server, tls::CaTlsConfig};
    use rcgen::generate_simple_self_signed;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_rustls::{
        TlsAcceptor, TlsConnector,
        rustls::{
            ClientConfig, RootCertStore, ServerConfig,
            pki_types::{PrivatePkcs8KeyDer, ServerName},
        },
    };

    pub(super) async fn private_relay_fixture()
    -> (server::Server, RelayUrl, WanEndpoint, WanEndpoint) {
        let socket: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let cert = generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let ca = cert.cert.der().clone();
        let key = PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der());
        let mut tls = ServerConfig::builder_with_provider(std::sync::Arc::new(
            tokio_rustls::rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![ca.clone()], key.into())
        .unwrap();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let mut relay = server::RelayConfig::new(socket);
        relay.tls = Some(server::TlsConfig::new(
            socket,
            server::CertConfig::Manual { server_config: tls },
        ));
        let mut config = server::ServerConfig::default();
        config.relay = Some(relay);
        let relay = server::Server::spawn(config).await.unwrap();
        let url: RelayUrl = format!("https://{}/", relay.https_addr().unwrap())
            .parse()
            .unwrap();
        let bind = |seed| {
            let url = url.clone();
            let ca = ca.clone();
            async move {
                let endpoint = make_builder(SecretKey::from_bytes(&[seed; 32]), None, Some(&url))
                    .unwrap()
                    .clear_ip_transports()
                    .ca_tls_config(CaTlsConfig::custom_roots([ca]))
                    .bind()
                    .await
                    .unwrap();
                let device = WanEndpoint {
                    endpoint,
                    relay: Some(url),
                };
                tokio::time::timeout(Duration::from_secs(5), device.endpoint.online())
                    .await
                    .unwrap();
                device
            }
        };
        let (receiver, sender) = tokio::join!(bind(1), bind(2));
        (relay, url, receiver, sender)
    }

    // No UDP: see a selected relay path, don't infer from configuration.
    #[tokio::test]
    async fn encrypted_bytes_can_use_operator_https_relay_without_any_direct_transport() {
        let (relay, url, receiver, sender) = private_relay_fixture().await;
        let route = WanRoute::new(receiver.id(), &[], Some(url)).unwrap();
        let allowed = HashSet::from([sender.id()]);
        // Separate TLS identity from the operator relay certificate, so a
        // successful outer QUIC handshake alone cannot authenticate this layer.
        let inner = generate_simple_self_signed(vec!["inner.example.invalid".into()]).unwrap();
        let leaf = inner.cert.der().clone();
        let key = PrivatePkcs8KeyDer::from(inner.signing_key.serialize_der());
        let provider = std::sync::Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
        let tls = ServerConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![leaf.clone()], key.into())
            .unwrap();
        let server_tls = TlsAcceptor::from(std::sync::Arc::new(tls));

        for inner_trust_correct in [false, true] {
            let mut trust = RootCertStore::empty();
            trust
                .add(if inner_trust_correct {
                    leaf.clone()
                } else {
                    generate_simple_self_signed(vec!["wrong.example.invalid".into()])
                        .unwrap()
                        .cert
                        .der()
                        .clone()
                })
                .unwrap();
            let config = ClientConfig::builder_with_provider(provider.clone())
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(trust)
                .with_no_client_auth();
            let client_tls = TlsConnector::from(std::sync::Arc::new(config));
            let send = async {
                let stream = sender.open(&route).await.unwrap();
                let hostname = ServerName::try_from("inner.example.invalid").unwrap();
                let result = client_tls.connect(hostname, stream).await;
                if !inner_trust_correct {
                    assert!(result.is_err(), "outer QUIC cannot satisfy inner TLS");
                    return;
                }
                let mut stream = result.unwrap();
                // At this point neither side relies on the selected route as identity.
                assert_eq!(stream.get_ref().0.selected_path(), Some(PathKind::Relay));
                stream.write_all(b"opaque").await.unwrap();
                let mut ack = [0u8; 1];
                stream.read_exact(&mut ack).await.unwrap();
                assert_eq!(&ack, b"k");
            };
            let receive = async {
                let (_, stream) = receiver.accept(&allowed).await.unwrap();
                assert_eq!(stream.selected_path(), Some(PathKind::Relay));
                let result = server_tls.accept(stream).await;
                if !inner_trust_correct {
                    assert!(result.is_err());
                    return;
                }
                let mut stream = result.unwrap();
                let mut payload = [0u8; 6];
                stream.read_exact(&mut payload).await.unwrap();
                assert_eq!(&payload, b"opaque");
                stream.write_all(b"k").await.unwrap();
                stream.shutdown().await.unwrap();
            };
            tokio::time::timeout(Duration::from_secs(10), async {
                tokio::join!(send, receive);
            })
            .await
            .unwrap();
        }
        tokio::join!(receiver.close(), sender.close());
        relay.shutdown().await.unwrap();
    }
}

#[cfg(test)]
mod pinned_remote_tests;
