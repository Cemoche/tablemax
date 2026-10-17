//! RNCryptor v3, password-based format (the container of TablePlus exports).
//!
//! `03 | 01 | enc_salt[8] | hmac_salt[8] | iv[16] | AES-256-CBC/PKCS#7 ciphertext |
//! HMAC-SHA256[32]`; both keys are PBKDF2-HMAC-SHA1(password, salt, 10 000, 32 bytes) and
//! the HMAC covers everything before it.

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockModeDecrypt, KeyIvInit};
use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;
use sha2::Sha256;

use crate::error::{AppError, AppResult, ErrorKind};

const VERSION: u8 = 3;
/// Options bit 0: keys derived from a password (else raw keys, no salts).
const PASSWORD_BASED: u8 = 0x01;
const PBKDF2_ROUNDS: u32 = 10_000;
/// version + options + encryption salt + HMAC salt + IV.
const HEADER_LEN: usize = 2 + 8 + 8 + 16;
const BLOCK_LEN: usize = 16;
const HMAC_LEN: usize = 32;

/// One message for every failure, so a caller cannot tell a wrong password from a
/// damaged or foreign file.
fn rejected() -> AppError {
    AppError::new(ErrorKind::Invalid, "wrong password or corrupted file")
}

fn key(password: &str, salt: &[u8]) -> [u8; 32] {
    pbkdf2::pbkdf2_hmac_array::<Sha1, 32>(password.as_bytes(), salt, PBKDF2_ROUNDS)
}

fn mac(password: &str, hmac_salt: &[u8], signed: &[u8]) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&key(password, hmac_salt))
        .expect("HMAC takes any key length");
    mac.update(signed);
    mac
}

/// Decrypts RNCryptor v3 password-based `data`. The HMAC is checked (in constant time)
/// before anything is decrypted.
pub fn decrypt(data: &[u8], password: &str) -> AppResult<Vec<u8>> {
    if data.len() < HEADER_LEN + BLOCK_LEN + HMAC_LEN
        || data[0] != VERSION
        || data[1] & PASSWORD_BASED == 0
    {
        return Err(rejected());
    }
    let (signed, tag) = data.split_at(data.len() - HMAC_LEN);
    mac(password, &data[10..18], signed)
        .verify_slice(tag)
        .map_err(|_| rejected())?;
    let iv: &[u8; 16] = data[18..HEADER_LEN].try_into().map_err(|_| rejected())?;
    cbc::Decryptor::<aes::Aes256>::new(&key(password, &data[2..10]).into(), iv.into())
        .decrypt_padded_vec::<Pkcs7>(&signed[HEADER_LEN..])
        .map_err(|_| rejected())
}

/// RNCryptor v3 password-based encryption with fixed salts and IV (tests only).
#[cfg(test)]
pub fn encrypt(plain: &[u8], password: &str, salts: ([u8; 8], [u8; 8]), iv: [u8; 16]) -> Vec<u8> {
    use aes::cipher::BlockModeEncrypt;
    let (enc_salt, hmac_salt) = salts;
    let mut out = vec![VERSION, PASSWORD_BASED];
    out.extend_from_slice(&enc_salt);
    out.extend_from_slice(&hmac_salt);
    out.extend_from_slice(&iv);
    out.extend(
        cbc::Encryptor::<aes::Aes256>::new(&key(password, &enc_salt).into(), &iv.into())
            .encrypt_padded_vec::<Pkcs7>(plain),
    );
    let tag = mac(password, &hmac_salt, &out).finalize().into_bytes();
    out.extend_from_slice(&tag);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    struct Vector {
        password: &'static str,
        enc_salt: &'static str,
        hmac_salt: &'static str,
        iv: &'static str,
        plaintext: &'static str,
        ciphertext: &'static str,
    }

    /// Source: RNCryptor-Spec, `vectors/v3/password`
    /// (https://github.com/RNCryptor/RNCryptor-Spec/blob/master/vectors/v3/password).
    const VECTORS: [Vector; 5] = [
        // "All fields empty or zero (with one-byte password)"
        Vector {
            password: "a",
            enc_salt: "0000000000000000",
            hmac_salt: "0000000000000000",
            iv: "00000000000000000000000000000000",
            plaintext: "",
            ciphertext: "03010000 00000000 00000000 00000000 00000000 00000000 00000000 \
                         00000000 0000b303 9be31cd7 ece5e754 f5c8da17 00366631 3ae8a89d \
                         dcf8e3cb 41fdc130 b2329dbe 07d6f4d3 2c34e050 c8bd7e93 3b12",
        },
        // "One byte"
        Vector {
            password: "thepassword",
            enc_salt: "0001020304050607",
            hmac_salt: "0102030405060708",
            iv: "02030405060708090a0b0c0d0e0f0001",
            plaintext: "01",
            ciphertext: "03010001 02030405 06070102 03040506 07080203 04050607 08090a0b \
                         0c0d0e0f 0001a1f8 730e0bf4 80eb7b70 f690abf2 1e029514 164ad3c4 \
                         74a51b30 c7eaa1ca 545b7de3 de5b010a cbad0a9a 13857df6 96a8",
        },
        // "Exactly one block"
        Vector {
            password: "thepassword",
            enc_salt: "0102030405060700",
            hmac_salt: "0203040506070801",
            iv: "030405060708090a0b0c0d0e0f000102",
            plaintext: "0123456789abcdef",
            ciphertext: "03010102 03040506 07000203 04050607 08010304 05060708 090a0b0c \
                         0d0e0f00 01020e43 7fe80930 9c03fd53 a475131e 9a1978b8 eaef576f \
                         60adb8ce 2320849b a32d7429 00438ba8 97d22210 c76c35c8 49df",
        },
        // "More than one block"
        Vector {
            password: "thepassword",
            enc_salt: "0203040506070001",
            hmac_salt: "0304050607080102",
            iv: "0405060708090a0b0c0d0e0f00010203",
            plaintext: "0123456789abcdef 01234567",
            ciphertext: "03010203 04050607 00010304 05060708 01020405 06070809 0a0b0c0d \
                         0e0f0001 0203e01b bda5df2c a8adace3 8f6c588d 291e03f9 51b78d34 \
                         17bc2816 581dc6b7 67f1a2e5 7597512b 18e1638f 21235fa5 928c",
        },
        // "Multibyte password"
        Vector {
            password: "中文密码",
            enc_salt: "0304050607000102",
            hmac_salt: "0405060708010203",
            iv: "05060708090a0b0c0d0e0f0001020304",
            plaintext: "23456789abcdef 0123456701",
            ciphertext: "03010304 05060700 01020405 06070801 02030506 0708090a 0b0c0d0e \
                         0f000102 03048a9e 08bdec1c 4bfe13e8 1fb85f00 9ab3ddb9 1387e809 \
                         c4ad86d9 e8a60145 57716657 bd317d4b b6a76446 15b3de40 2341",
        },
    ];

    const REJECTED: &str = "wrong password or corrupted file";

    fn assert_rejected(result: AppResult<Vec<u8>>) {
        let err = result.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(err.message, REJECTED);
    }

    fn array<const N: usize>(s: &str) -> [u8; N] {
        hex(s).try_into().unwrap()
    }

    #[test]
    fn decrypts_official_v3_password_vectors() {
        for v in &VECTORS {
            assert_eq!(
                decrypt(&hex(v.ciphertext), v.password).unwrap(),
                hex(v.plaintext),
                "vector with password {:?}",
                v.password
            );
        }
    }

    #[test]
    fn test_encrypt_reproduces_official_vectors() {
        for v in &VECTORS {
            let salts = (array(v.enc_salt), array(v.hmac_salt));
            assert_eq!(
                encrypt(&hex(v.plaintext), v.password, salts, array(v.iv)),
                hex(v.ciphertext)
            );
        }
    }

    #[test]
    fn wrong_password_is_rejected() {
        for v in &VECTORS {
            assert_rejected(decrypt(&hex(v.ciphertext), "wrong"));
        }
    }

    #[test]
    fn flipped_byte_is_rejected() {
        let ct = hex(VECTORS[3].ciphertext);
        // One byte in each field: version, options, encryption salt, HMAC salt, IV,
        // ciphertext (first and last block) and HMAC (first and last byte).
        let n = ct.len();
        for i in [0, 1, 2, 10, 18, 33, 34, n - 33, n - 32, n - 1] {
            let mut bad = ct.clone();
            bad[i] ^= 0x01;
            assert_rejected(decrypt(&bad, VECTORS[3].password));
        }
    }

    #[test]
    fn truncated_is_rejected() {
        let ct = hex(VECTORS[3].ciphertext);
        for len in [0, 1, 2, 33, 34, 66, 81, ct.len() - 16, ct.len() - 1] {
            assert_rejected(decrypt(&ct[..len], VECTORS[3].password));
        }
    }

    #[test]
    fn key_based_format_is_rejected() {
        // Options bit 0 cleared = key-based RNCryptor data (no salts): not an export.
        let mut ct = hex(VECTORS[1].ciphertext);
        ct[1] = 0;
        assert_rejected(decrypt(&ct, VECTORS[1].password));
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let plain = "[{\"ConnectionName\":\"é\"}]".as_bytes();
        let data = encrypt(plain, "pässword", ([7; 8], [9; 8]), [3; 16]);
        assert_eq!(decrypt(&data, "pässword").unwrap(), plain);
        assert_rejected(decrypt(&data, "password"));
    }
}
