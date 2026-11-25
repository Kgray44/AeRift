use std::sync::Arc;

use aerift_transfer::{ErrorCode, PeerId, TransferError};
use serde::{Deserialize, Serialize};
use tokio_rustls::rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, DistinguishedName, Error, ServerConfig,
    SignatureScheme,
    client::{
        Resumption,
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    },
    crypto::{ring::default_provider, verify_tls13_signature},
    pki_types::{CertificateDer, PrivatePkcs8KeyDer, ServerName, UnixTime},
    server::danger::{ClientCertVerified, ClientCertVerifier},
    version::TLS13,
};
use x509_parser::prelude::*;

const ALPN: &[u8] = b"http/1.1";
const P256: SignatureScheme = SignatureScheme::ECDSA_NISTP256_SHA256;

/// Implement with the platform's protected storage. The write must be atomic and
/// return the winning identity if a second creator already initialized the store.
pub trait SecretStore {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError>;
    fn initialize(&self, candidate: &[u8]) -> Result<Vec<u8>, TransferError>;
}

/// Certificate and native private key. This type intentionally has no Debug impl.
pub struct Identity {
    certificate: CertificateDer<'static>,
    key: PrivatePkcs8KeyDer<'static>,
}

#[derive(Deserialize, Serialize)]
struct StoredIdentity {
    certificate: Vec<u8>,
    key: Vec<u8>,
}

impl Identity {
    pub fn load_or_create(store: &(impl SecretStore + ?Sized)) -> Result<Self, TransferError> {
        let stored = match store.load()? {
            Some(stored) => stored,
            None => {
                let key = rcgen::KeyPair::generate().map_err(|_| ErrorCode::StorageFailed)?;
                let certificate = rcgen::CertificateParams::default()
                    .self_signed(&key)
                    .map_err(|_| ErrorCode::StorageFailed)?;
                let data = serde_json::to_vec(&StoredIdentity {
                    certificate: certificate.der().to_vec(),
                    key: key.serialize_der(),
                })
                .map_err(|_| ErrorCode::StorageFailed)?;
                store.initialize(&data)?
            }
        };
        let stored: StoredIdentity =
            serde_json::from_slice(&stored).map_err(|_| ErrorCode::StorageFailed)?;
        let certificate = CertificateDer::from(stored.certificate);
        profile(&certificate, &[]).map_err(|_| ErrorCode::StorageFailed)?;
        let identity = Self {
            certificate,
            key: PrivatePkcs8KeyDer::from(stored.key),
        };
        // The standard configuration builder also verifies the key matches its leaf.
        identity.server_config()?;
        Ok(identity)
    }

    pub(crate) fn certificate_der(&self) -> &[u8] {
        self.certificate.as_ref()
    }

    pub(crate) fn sign_wan_invitation(&self, body: &[u8]) -> Result<Vec<u8>, TransferError> {
        use ring::{
            rand::SystemRandom,
            signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair},
        };
        let rng = SystemRandom::new();
        let key = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_ASN1_SIGNING,
            self.key.secret_pkcs8_der(),
            &rng,
        )
        .map_err(|_| ErrorCode::StorageFailed)?;
        let message = crate::wan_invitation::transcript(body);
        Ok(key
            .sign(&rng, &message)
            .map_err(|_| ErrorCode::InternalError)?
            .as_ref()
            .to_vec())
    }

    pub fn id(&self) -> PeerId {
        PeerId::from_tls_leaf(self.certificate.as_ref())
    }

    pub(crate) fn client_config(&self, expected: PeerId) -> Result<ClientConfig, TransferError> {
        let mut config = ClientConfig::builder_with_provider(Arc::new(default_provider()))
            .with_protocol_versions(&[&TLS13])
            .map_err(|_| ErrorCode::StorageFailed)?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinnedServer(expected)))
            .with_client_auth_cert(vec![self.certificate.clone()], self.key.clone_key().into())
            .map_err(|_| ErrorCode::StorageFailed)?;
        config.resumption = Resumption::disabled();
        config.alpn_protocols = vec![ALPN.to_vec()];
        Ok(config)
    }

    pub(crate) fn server_config(&self) -> Result<ServerConfig, TransferError> {
        let mut config = ServerConfig::builder_with_provider(Arc::new(default_provider()))
            .with_protocol_versions(&[&TLS13])
            .map_err(|_| ErrorCode::StorageFailed)?
            .with_client_cert_verifier(Arc::new(DeviceClient))
            .with_single_cert(vec![self.certificate.clone()], self.key.clone_key().into())
            .map_err(|_| ErrorCode::StorageFailed)?;
        config.send_tls13_tickets = 0;
        config.alpn_protocols = vec![ALPN.to_vec()];
        Ok(config)
    }
}

pub(crate) fn profile(
    leaf: &CertificateDer<'_>,
    intermediates: &[CertificateDer<'_>],
) -> Result<(), Error> {
    let invalid = || Error::InvalidCertificate(CertificateError::BadEncoding);
    if !intermediates.is_empty() || leaf.len() > 4096 {
        return Err(invalid());
    }
    let (trailing, cert) = parse_x509_certificate(leaf.as_ref()).map_err(|_| invalid())?;
    let public_key = cert.public_key();
    let curve = public_key
        .algorithm
        .parameters
        .as_ref()
        .and_then(|parameter| parameter.as_oid().ok());
    if !trailing.is_empty()
        || cert.subject() != cert.issuer()
        || public_key.algorithm.algorithm.to_id_string() != "1.2.840.10045.2.1"
        || !curve.is_some_and(|curve| curve.to_id_string() == "1.2.840.10045.3.1.7")
        || cert.signature_algorithm.algorithm.to_id_string() != "1.2.840.10045.4.3.2"
        || !cert.validity().is_valid()
        || cert.is_ca()
    {
        return Err(invalid());
    }
    cert.verify_signature(None)
        .map_err(|_| Error::InvalidCertificate(CertificateError::BadSignature))
}

fn verify_proof(
    message: &[u8],
    cert: &CertificateDer<'_>,
    proof: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, Error> {
    if proof.scheme != P256 {
        return Err(Error::InvalidCertificate(CertificateError::BadSignature));
    }
    verify_tls13_signature(
        message,
        cert,
        proof,
        &default_provider().signature_verification_algorithms,
    )
}

#[derive(Debug)]
struct PinnedServer(PeerId);

impl ServerCertVerifier for PinnedServer {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        chain: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        profile(cert, chain)?;
        if PeerId::from_tls_leaf(cert.as_ref()) != self.0 {
            return Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::InvalidCertificate(CertificateError::BadSignature))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        proof: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_proof(message, cert, proof)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![P256]
    }
}

#[derive(Debug)]
struct DeviceClient;

impl ClientCertVerifier for DeviceClient {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        cert: &CertificateDer<'_>,
        chain: &[CertificateDer<'_>],
        _: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        profile(cert, chain)?;
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::InvalidCertificate(CertificateError::BadSignature))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        proof: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_proof(message, cert, proof)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![P256]
    }
}
