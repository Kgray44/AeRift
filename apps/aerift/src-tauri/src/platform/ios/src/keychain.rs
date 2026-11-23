use core_foundation::{
    base::{CFType, TCFType},
    boolean::CFBoolean,
    data::CFData,
    dictionary::CFDictionary,
    string::CFString,
};
use security_framework_sys::{
    base::{
        errSecDuplicateItem as DUPLICATE_ITEM, errSecItemNotFound as ITEM_NOT_FOUND,
        errSecSuccess as SUCCESS,
    },
    item::{
        kSecAttrAccount, kSecAttrService, kSecAttrSynchronizable, kSecClass,
        kSecClassGenericPassword, kSecReturnData, kSecValueData,
    },
    keychain_item::{SecItemAdd, SecItemCopyMatching, SecItemUpdate},
};
use std::{fmt, ptr};

const SERVICE: &str = "com.aerift.app.peers.v1";
const IDENTITY: &str = "identity";
const TRUST: &str = "trust";

// These documented Security.framework attributes are not exported by the
// security-framework-sys item module.
extern "C" {
    static kSecAttrAccessible: <CFString as TCFType>::Ref;
    static kSecAttrAccessibleWhenUnlockedThisDeviceOnly: <CFString as TCFType>::Ref;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeychainError {
    Access(i32),
    InvalidResult,
}

impl fmt::Display for KeychainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Access(status) => write!(formatter, "iOS Keychain error {status}"),
            Self::InvalidResult => formatter.write_str("iOS Keychain returned an invalid result"),
        }
    }
}

impl std::error::Error for KeychainError {}

/// Secrets reside in the app's default Keychain access group, on this iPhone.
pub struct IosKeychain;

impl IosKeychain {
    pub fn load_identity(&self) -> Result<Option<Vec<u8>>, KeychainError> {
        read(IDENTITY)
    }

    /// Returns false if another initializer already created the item. Re-read it
    /// before using an identity, since the winning certificate defines the peer ID.
    pub fn insert_identity(&self, bytes: &[u8]) -> Result<bool, KeychainError> {
        insert(IDENTITY, bytes)
    }

    pub fn load_trust(&self) -> Result<Option<Vec<u8>>, KeychainError> {
        read(TRUST)
    }

    /// Publishes the complete trust snapshot in one Keychain update. The shared
    /// engine serializes any read-modify-write of this snapshot.
    pub fn replace_trust(&self, bytes: &[u8]) -> Result<(), KeychainError> {
        if insert(TRUST, bytes)? {
            return Ok(());
        }
        let matching = CFDictionary::from_CFType_pairs(&attributes(TRUST));
        // SAFETY: kSecValueData is a Security.framework CFString constant.
        let key = unsafe { CFString::wrap_under_get_rule(kSecValueData) };
        let changes =
            CFDictionary::from_CFType_pairs(&[(key, CFData::from_buffer(bytes).into_CFType())]);

        // SAFETY: Both Core Foundation dictionaries are retained for the call.
        let status =
            unsafe { SecItemUpdate(matching.as_concrete_TypeRef(), changes.as_concrete_TypeRef()) };
        if status == SUCCESS {
            Ok(())
        } else {
            Err(KeychainError::Access(status))
        }
    }
}

fn attributes(account: &str) -> Vec<(CFString, CFType)> {
    // SAFETY: These immutable keys and values are system-owned CFString constants.
    unsafe {
        vec![
            (
                CFString::wrap_under_get_rule(kSecClass),
                CFString::wrap_under_get_rule(kSecClassGenericPassword).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrService),
                CFString::new(SERVICE).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrAccount),
                CFString::new(account).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrSynchronizable),
                CFBoolean::false_value().into_CFType(),
            ),
        ]
    }
}

fn read(account: &str) -> Result<Option<Vec<u8>>, KeychainError> {
    let mut query = attributes(account);
    // SAFETY: kSecReturnData is a Security.framework CFString constant.
    query.push(unsafe {
        (
            CFString::wrap_under_get_rule(kSecReturnData),
            CFBoolean::true_value().into_CFType(),
        )
    });
    let query = CFDictionary::from_CFType_pairs(&query);
    let mut result = ptr::null();

    // SAFETY: The dictionary lives through the call and result is writable.
    let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) };
    match status {
        ITEM_NOT_FOUND => Ok(None),
        SUCCESS if !result.is_null() => {
            // SAFETY: A successful SecItemCopyMatching returns a retained CF object.
            let value = unsafe { CFType::wrap_under_create_rule(result) };
            let bytes = value
                .downcast_into::<CFData>()
                .ok_or(KeychainError::InvalidResult)?;
            Ok(Some(bytes.bytes().to_vec()))
        }
        SUCCESS => Err(KeychainError::InvalidResult),
        _ => Err(KeychainError::Access(status)),
    }
}

fn insert(account: &str, bytes: &[u8]) -> Result<bool, KeychainError> {
    let mut query = attributes(account);
    // SAFETY: These immutable keys and values are system-owned CFString constants.
    query.extend(unsafe {
        [
            (
                CFString::wrap_under_get_rule(kSecAttrAccessible),
                CFString::wrap_under_get_rule(kSecAttrAccessibleWhenUnlockedThisDeviceOnly)
                    .into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecValueData),
                CFData::from_buffer(bytes).into_CFType(),
            ),
        ]
    });
    let query = CFDictionary::from_CFType_pairs(&query);

    // SAFETY: The dictionary lives through the call. We do not request an item result.
    let status = unsafe { SecItemAdd(query.as_concrete_TypeRef(), ptr::null_mut()) };
    match status {
        SUCCESS => Ok(true),
        DUPLICATE_ITEM => Ok(false),
        _ => Err(KeychainError::Access(status)),
    }
}
