//! TLS settings shared by the PostgreSQL and MySQL/MariaDB drivers (rustls + ring).
//!
//! Modes follow libpq: `Prefer` and `Require` encrypt without checking the certificate
//! (`Prefer` falls back to cleartext when the server has no TLS), `VerifyCa` checks the
//! chain but not the host name, `VerifyFull` checks both. Even when the certificate is
//! not checked, the handshake signature is, so the session keys stay bound to the
//! certificate the server presented.
//!
//! Trust roots: a configured CA file replaces every other root. Without one, the OS store
//! is used, or the bundled Mozilla roots when the OS store is empty.
//!
//! Errors about the CA / client certificate / client key files name the file and its
//! role, never its content (a key file must never end up in a message or a log).

use std::sync::Arc;

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorKind};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SslConfig {
    pub mode: SslMode,
    pub ca_file: Option<String>,
    pub cert_file: Option<String>,
    pub key_file: Option<String>,
}

/// Installs ring as the process-wide rustls provider (mysql_async builds its
/// `ClientConfig` from the process default). Idempotent.
pub fn install_crypto_provider() {
    // Err only means a provider is already installed.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// The PEM files of an `SslConfig`, read and checked (not yet parsed into rustls types).
pub(crate) struct TlsFiles {
    pub ca: Option<Vec<u8>>,
    /// Client certificate chain and key, always together.
    pub identity: Option<(Vec<u8>, Vec<u8>)>,
}

fn read_file(path: &str, what: &str) -> AppResult<Vec<u8>> {
    std::fs::read(path).map_err(|e| {
        AppError::new(
            ErrorKind::Invalid,
            format!("cannot read {what} \"{path}\": {e}"),
        )
    })
}

/// Parses every certificate of a PEM file; the message never includes the content.
fn parse_certs(pem: &[u8], path: &str, what: &str) -> AppResult<Vec<CertificateDer<'static>>> {
    let certs = CertificateDer::pem_slice_iter(pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| {
            AppError::new(
                ErrorKind::Invalid,
                format!("{what} \"{path}\" is not a valid PEM file"),
            )
        })?;
    if certs.is_empty() {
        return Err(AppError::new(
            ErrorKind::Invalid,
            format!("{what} \"{path}\" contains no PEM certificate"),
        ));
    }
    Ok(certs)
}

/// Accepts PKCS#8, PKCS#1 and SEC1 keys; encrypted keys are not supported.
fn parse_key(pem: &[u8], path: &str) -> AppResult<PrivateKeyDer<'static>> {
    PrivateKeyDer::from_pem_slice(pem).map_err(|_| {
        AppError::new(
            ErrorKind::Invalid,
            format!("client key \"{path}\" is not an unencrypted PEM private key"),
        )
    })
}

/// Reads and validates the files named by `ssl` (whatever the mode).
pub(crate) fn load_files(ssl: &SslConfig) -> AppResult<TlsFiles> {
    let ca = match &ssl.ca_file {
        Some(path) => {
            let pem = read_file(path, "CA file")?;
            parse_certs(&pem, path, "CA file")?;
            Some(pem)
        }
        None => None,
    };
    let identity = match (&ssl.cert_file, &ssl.key_file) {
        (Some(cert_path), Some(key_path)) => {
            let cert = read_file(cert_path, "client certificate")?;
            parse_certs(&cert, cert_path, "client certificate")?;
            let key = read_file(key_path, "client key")?;
            parse_key(&key, key_path)?;
            Some((cert, key))
        }
        (None, None) => None,
        _ => {
            return Err(AppError::new(
                ErrorKind::Invalid,
                "a client certificate needs a client key, and a client key needs a certificate",
            ));
        }
    };
    Ok(TlsFiles { ca, identity })
}

/// OS trust store certificates that rustls accepts as trust anchors (unparsable ones are
/// skipped). Empty when the OS store is missing or unreadable.
pub(crate) fn native_roots() -> Vec<CertificateDer<'static>> {
    rustls_native_certs::load_native_certs()
        .certs
        .into_iter()
        .filter(|c| RootCertStore::empty().add(c.clone()).is_ok())
        .collect()
}

fn root_store(ca: Option<&[u8]>) -> AppResult<RootCertStore> {
    let mut roots = RootCertStore::empty();
    match ca {
        Some(pem) => {
            for cert in CertificateDer::pem_slice_iter(pem).flatten() {
                roots.add(cert).map_err(|e| {
                    AppError::new(
                        ErrorKind::Invalid,
                        format!("CA file holds an unusable certificate: {e}"),
                    )
                })?;
            }
        }
        None => {
            roots.add_parsable_certificates(native_roots());
            if roots.is_empty() {
                roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            }
        }
    }
    Ok(roots)
}

fn tls_err(e: rustls::Error) -> AppError {
    AppError::new(ErrorKind::Invalid, format!("TLS configuration error: {e}"))
}

/// `Prefer` / `Require`: accept any certificate, but still verify the handshake signature.
#[derive(Debug)]
struct NoVerify(Arc<CryptoProvider>);

impl ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        msg: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(msg, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        msg: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(msg, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// `VerifyCa`: full chain validation; only a host name mismatch is forgiven.
#[derive(Debug)]
struct VerifyCaOnly(Arc<WebPkiServerVerifier>);

impl ServerCertVerifier for VerifyCaOnly {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self
            .0
            .verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
        {
            Err(rustls::Error::InvalidCertificate(
                CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
            )) => Ok(ServerCertVerified::assertion()),
            other => other,
        }
    }

    fn verify_tls12_signature(
        &self,
        msg: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls12_signature(msg, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        msg: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls13_signature(msg, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}

/// The rustls client configuration for `ssl`, or `None` for `Disable`.
pub fn rustls_client_config(ssl: &SslConfig) -> AppResult<Option<Arc<ClientConfig>>> {
    if ssl.mode == SslMode::Disable {
        return Ok(None);
    }
    let files = load_files(ssl)?;
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(tls_err)?;
    let builder = match ssl.mode {
        SslMode::Disable | SslMode::Prefer | SslMode::Require => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify(provider.clone()))),
        SslMode::VerifyCa => {
            let roots = Arc::new(root_store(files.ca.as_deref())?);
            let inner = WebPkiServerVerifier::builder_with_provider(roots, provider.clone())
                .build()
                .map_err(|e| {
                    AppError::new(ErrorKind::Invalid, format!("TLS configuration error: {e}"))
                })?;
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(VerifyCaOnly(inner)))
        }
        SslMode::VerifyFull => builder.with_root_certificates(root_store(files.ca.as_deref())?),
    };
    let config = match &files.identity {
        Some((cert, key)) => {
            // Both were validated by `load_files`; only the pairing can still fail.
            let chain = CertificateDer::pem_slice_iter(cert)
                .flatten()
                .collect::<Vec<_>>();
            let key = PrivateKeyDer::from_pem_slice(key).map_err(|_| {
                AppError::new(
                    ErrorKind::Invalid,
                    "client key is not a valid PEM private key",
                )
            })?;
            builder.with_client_auth_cert(chain, key).map_err(|e| {
                AppError::new(
                    ErrorKind::Invalid,
                    format!("client certificate and client key are not usable together: {e}"),
                )
            })?
        }
        None => builder.with_no_client_auth(),
    };
    Ok(Some(Arc::new(config)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disable_has_no_config() {
        assert!(
            rustls_client_config(&SslConfig {
                mode: SslMode::Disable,
                ..Default::default()
            })
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn prefer_without_files_builds_a_config() {
        install_crypto_provider();
        assert!(
            rustls_client_config(&SslConfig::default())
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn missing_ca_file_is_invalid() {
        let e = rustls_client_config(&SslConfig {
            mode: SslMode::VerifyFull,
            ca_file: Some("/nope/ca.pem".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid);
        assert!(e.message.contains("CA file"), "{}", e.message);
        assert!(e.message.contains("/nope/ca.pem"), "{}", e.message);
    }

    #[test]
    fn cert_without_key_is_invalid() {
        let e = rustls_client_config(&SslConfig {
            mode: SslMode::Require,
            cert_file: Some("/nope/client.pem".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid);
        let e = rustls_client_config(&SslConfig {
            mode: SslMode::Require,
            key_file: Some("/nope/client.key".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid);
    }

    #[test]
    fn invalid_pem_is_invalid_and_never_echoes_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.pem");
        std::fs::write(&path, "-----BEGIN CERTIFICATE-----\nSECRETSTUFF!!\n").unwrap();
        let path = path.to_string_lossy().into_owned();
        for (cfg, what) in [
            (
                SslConfig {
                    mode: SslMode::VerifyFull,
                    ca_file: Some(path.clone()),
                    ..Default::default()
                },
                "CA file",
            ),
            (
                SslConfig {
                    mode: SslMode::Require,
                    cert_file: Some(path.clone()),
                    key_file: Some(path.clone()),
                    ..Default::default()
                },
                "client certificate",
            ),
        ] {
            let e = rustls_client_config(&cfg).unwrap_err();
            assert_eq!(e.kind, ErrorKind::Invalid);
            assert!(e.message.contains(what), "{}", e.message);
            assert!(!e.message.contains("SECRETSTUFF"), "{}", e.message);
        }
    }

    #[test]
    fn invalid_client_key_names_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("client.key");
        std::fs::write(&key, "-----BEGIN PRIVATE KEY-----\nTOPSECRET\n").unwrap();
        // The certificate is checked first: give it a well-formed PEM block (its DER
        // content is only checked later, by rustls) so the key is the one rejected.
        let cert = dir.path().join("client.pem");
        std::fs::write(
            &cert,
            "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
        )
        .unwrap();
        let e = rustls_client_config(&SslConfig {
            mode: SslMode::Require,
            cert_file: Some(cert.to_string_lossy().into_owned()),
            key_file: Some(key.to_string_lossy().into_owned()),
            ..Default::default()
        })
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid);
        assert!(e.message.contains("client key"), "{}", e.message);
        assert!(!e.message.contains("TOPSECRET"), "{}", e.message);
    }

    #[test]
    fn ssl_config_serde_default_is_prefer() {
        let c: SslConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(c.mode, SslMode::Prefer);
        let c: SslConfig =
            serde_json::from_str(r#"{"mode":"verifyFull","caFile":"/ca.pem"}"#).unwrap();
        assert_eq!(c.mode, SslMode::VerifyFull);
        assert_eq!(c.ca_file.as_deref(), Some("/ca.pem"));
    }
}
