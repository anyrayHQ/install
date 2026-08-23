#!/usr/bin/env python3
"""Independently verify the Authenticode signature on a released Windows binary.

WHY THIS EXISTS RATHER THAN `osslsigncode verify`. The release runner is
`amazonlinux2-x86_64-standard:5.0`, which despite the name is **Amazon Linux
2023**. The previous version of this check ran `sudo apt-get install
osslsigncode` — apt does not exist there, and osslsigncode is not in the AL2023
repositories either, so the step could only ever have failed. It never did,
because the Windows lane was gated on a variable that was never set, so the
whole job skipped on every release. Adding a package build to the release path
would put a compile between us and shipping; this uses only python3 and openssl,
both already present.

WHAT IT PROVES, and why each check is here rather than trusting the signer:

  1. A signature is present at all.
  2. The Authenticode digest recomputed from the shipped bytes equals the digest
     the signature attests. This is the check that makes the rest mean anything:
     without it the other three would pass on a signature lifted from a
     different file.
  3. The certificate chain verifies to a pinned trust anchor (openssl does this
     part — the cryptography is not reimplemented here).
  4. The signature is countersigned by a timestamp authority. Azure's signing
     certificates are valid for THREE DAYS, so an un-timestamped signature would
     go invalid within the week on machines that already installed it.
  5. The publisher is who we expect. This account carries several identity
     validations; a profile built against the wrong one signs perfectly well
     under the wrong company name.

VALIDATED AGAINST AN ORACLE. The PE parsing and digest computation were checked
against osslsigncode 2.14 on a real signed binary: the extracted PKCS#7 is
byte-identical (modulo the 8-byte alignment padding osslsigncode also strips)
and the recomputed digest matches its "Calculated message digest" exactly. Each
check was also confirmed to FAIL on the case it exists to catch.

WHAT IT DOES NOT PROVE — read this before trusting a green check.

**It does not verify the RSA signature over the SignerInfo.** Checks 2 and 3 are
asserted independently and never joined: nothing here proves the certificate that
chains to Microsoft is the certificate whose key produced the signature, nor that
the digest compared in check 2 is the one the signer actually signed. A PKCS#7
that is well-formed but cryptographically invalid — a corrupt or truncated
`encryptedDigest` from a jsign or service-side fault — passes every check below
while Windows rejects the binary on every machine.

That gap is deliberate, and the obvious fix is a trap worth documenting. The
natural move is `openssl smime -verify -inform DER`, which reports "Verification
successful" on an Authenticode PKCS#7 and exits 0. **It does not verify the
signature here.** Measured on OpenSSL 3.6.3: flipping a byte inside the
`encryptedDigest` OCTET STRING still yields "Verification successful" and exit 0,
because the eContentType is `SpcIndirectDataContent` rather than `pkcs7-data`, so
openssl validates the certificate path and never checks the signature math over
the detached content. Adding that call would have made this script *look* like it
verifies signatures while proving no more than it does now — strictly worse than
the honest gap, because the comment would lie. Do not add it back.

So the question this answers is "did our pipeline sign the bytes we are about to
ship, with the certificate profile we intended" — a misconfiguration check, run
inside our own release job immediately after our own signing step. It is NOT an
adversarial verification of a binary from an untrusted source. For that, use
`osslsigncode verify` on a machine that has it (not this runner — see above), or
`signtool verify /pa` on Windows. Closing the gap properly means a real
Authenticode implementation, not another openssl flag.

Usage:
  verify-authenticode.py <binary> --ca-file <pem> --expect-publisher <string>
"""
import argparse
import hashlib
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

WIN_CERT_HDR = 8  # dwLength(4) + wRevision(2) + wCertificateType(2)
SPC_INDIRECT_DATA = "1.3.6.1.4.1.311.2.1.4"
# Either shape of countersignature counts: the RFC3161 timestamp token Azure and
# jsign emit, or the legacy PKCS#9 counterSignature attribute.
#
# MATCH BOTH THE DOTTED OID AND THE NAME. `openssl asn1parse` prints an OID by
# NAME when its objects table knows it and dotted when it does not, so the form
# that appears is a property of the OpenSSL build, not of the signature.
# Verified on OpenSSL 3.6.3: 1.2.840.113549.1.9.6 prints as `:countersignature`
# and never dotted, so matching only the dotted string made that arm dead code —
# it could never have fired. The Microsoft OIDs print dotted today, but a future
# OpenSSL that learns them would silently break this the other way.
TIMESTAMP_MARKERS = (
    "1.3.6.1.4.1.311.3.3.1",  # RFC3161 timestamp token (what we actually get)
    "1.2.840.113549.1.9.6",   # PKCS#9 countersignature, dotted
    ":countersignature",      # …and the same OID as OpenSSL renders it
)


def fail(msg: str) -> "None":
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


def _offsets(data: bytes):
    if data[:2] != b"MZ":
        fail("not a PE file: missing MZ header")
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe : pe + 4] != b"PE\0\0":
        fail("not a PE file: missing PE signature")
    opt = pe + 4 + 20
    magic = struct.unpack_from("<H", data, opt)[0]
    if magic == 0x20B:
        ddir = opt + 112     # PE32+
    elif magic == 0x10B:
        ddir = opt + 96      # PE32
    else:
        fail(f"unrecognised optional header magic {magic:#x}")
    return opt + 64, ddir + 4 * 8  # (CheckSum field, certificate table entry)


def extract_signature(data: bytes) -> bytes:
    _, cert_entry = _offsets(data)
    offset, size = struct.unpack_from("<II", data, cert_entry)
    if offset == 0 or size == 0:
        fail("binary carries NO Authenticode signature — it shipped unsigned")
    blob = data[offset : offset + size]
    length = struct.unpack_from("<I", blob, 0)[0]
    # The attribute certificate table is a LIST. Verifying the first entry and
    # calling the file signed would let a second, unexamined signature ride
    # along. Entries are 8-byte aligned, so the table holds exactly one iff the
    # first entry's padded length fills it. Fail loudly rather than quietly
    # inspecting a subset.
    if length > size or (length + 7) // 8 * 8 < size:
        fail(
            f"certificate table holds more than one entry (first is {length} "
            f"bytes of {size}) — this file carries multiple signatures and this "
            "script only inspects the first; verify it by hand"
        )
    return _trim_der(blob[WIN_CERT_HDR:length])


def _trim_der(blob: bytes) -> bytes:
    """Drop the alignment padding after the PKCS#7 SEQUENCE.

    WIN_CERTIFICATE entries are padded to an 8-byte boundary, so the slice
    usually carries a byte or three of trailing zeros. `openssl asn1parse`
    tolerates some of that and rejects other amounts — measured on OpenSSL
    3.6.3, a 2-byte tail parsed fine while a 1-byte tail failed with "header too
    long", which reads like a corrupt signature rather than padding and cost a
    real debugging detour. Trim to the length the outer SEQUENCE declares.
    """
    if len(blob) < 2 or blob[0] != 0x30:
        return blob  # not what we expected; let the parser report it
    n = blob[1]
    if n & 0x80:
        count = n & 0x7F
        declared = int.from_bytes(blob[2 : 2 + count], "big") + 2 + count
    else:
        declared = n + 2
    return blob[:declared] if 0 < declared <= len(blob) else blob


def authenticode_digest(data: bytes, algo: str) -> str:
    """The PE hash Authenticode covers: everything except the two fields signing
    itself rewrites (CheckSum, the certificate-table directory entry) and the
    appended signature blob."""
    checksum, cert_entry = _offsets(data)
    offset, size = struct.unpack_from("<II", data, cert_entry)
    h = hashlib.new(algo)
    h.update(data[:checksum])
    h.update(data[checksum + 4 : cert_entry])
    h.update(data[cert_entry + 8 : offset])
    if len(data) > offset + size:
        h.update(data[offset + size :])
    return h.hexdigest()


def openssl(args, stdin=None) -> str:
    p = subprocess.run(
        ["openssl", *args], input=stdin, capture_output=True, text=False
    )
    if p.returncode != 0:
        fail(f"openssl {' '.join(args[:2])} failed: {p.stderr.decode(errors='replace').strip()}")
    return p.stdout.decode(errors="replace")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("binary")
    ap.add_argument("--ca-file", required=True)
    ap.add_argument("--expect-publisher", required=True)
    a = ap.parse_args()

    data = Path(a.binary).read_bytes()
    sig = extract_signature(data)

    with tempfile.TemporaryDirectory() as tmp:
        p7 = Path(tmp) / "sig.p7b"
        p7.write_bytes(sig)
        asn1 = openssl(["asn1parse", "-inform", "DER", "-in", str(p7)])

        # (2) tamper check — the attested digest lives in SpcIndirectDataContent.
        if SPC_INDIRECT_DATA not in asn1:
            fail("signature is not Authenticode (no SpcIndirectDataContent)")
        # Anchor on the FIRST digest-algorithm OID after SpcIndirectDataContent
        # and the FIRST OCTET STRING after that, and require them adjacent in
        # the parse. The region also contains later OCTET STRINGs — X.509
        # extension values such as keyUsage and the authority key identifier —
        # so a looser scan would happily return one of those. Requiring the pair
        # to sit next to each other is what pins this to the DigestInfo, since
        # the messageDigest is by construction the octet string immediately
        # following its own AlgorithmIdentifier.
        spc = asn1.split(SPC_INDIRECT_DATA, 1)[1]
        pair = re.search(
            r"OBJECT\s+:(sha1|sha256|sha384|sha512)\s*\n"
            r"(?:.*NULL.*\n)?"
            r".*OCTET STRING\s+\[HEX DUMP\]:([0-9A-Fa-f]+)",
            spc,
        )
        if not pair:
            fail(
                "could not locate the attested digest in SpcIndirectDataContent "
                "— the signature layout is not what this script was written for; "
                "verify by hand rather than assuming it is fine"
            )
        algo, attested = pair.group(1), pair.group(2).lower()
        expected_len = {"sha1": 40, "sha256": 64, "sha384": 96, "sha512": 128}[algo]
        if len(attested) != expected_len:
            fail(
                f"attested digest is {len(attested)} hex chars, expected "
                f"{expected_len} for {algo} — parsed the wrong ASN.1 field"
            )
        actual = authenticode_digest(data, algo)
        if attested != actual:
            fail(
                "signature does NOT cover these bytes — the file was modified "
                f"after signing (attested {attested}, actual {actual})"
            )

        # (4) timestamp.
        if not any(o in asn1 for o in TIMESTAMP_MARKERS):
            fail(
                "signed but NOT timestamped — an Azure signing certificate is "
                "valid for 3 days, so this signature would go invalid within the "
                "week on every machine that already installed it"
            )

        # (3) chain, and (5) publisher.
        certs = openssl(["pkcs7", "-inform", "DER", "-in", str(p7), "-print_certs"])
        blocks = re.findall(
            r"subject=(?P<s>.*?)\n.*?(?P<pem>-----BEGIN CERTIFICATE-----.*?"
            r"-----END CERTIFICATE-----)",
            certs,
            re.S,
        )
        if not blocks:
            fail("signature contains no certificates")

        # Match the ORGANISATION RDN exactly, not a substring of the whole DN.
        # `expect in subject_line` would accept `O=Othentic Labs LTD Holdings`,
        # or any certificate that merely mentions the phrase in some other
        # field — the same substring-instead-of-structure mistake
        # security-patterns.md calls out for URLs. openssl prints DNs as
        # `O = Acme` (3.x) or `/O=Acme` (1.x), so tolerate both spacings.
        def org_matches(subject: str) -> bool:
            for rdn in re.split(r",\s*(?=[A-Za-z]+\s*=)|/(?=[A-Za-z]+=)", subject):
                k, _, v = rdn.partition("=")
                if k.strip().upper() == "O" and v.strip() == a.expect_publisher:
                    return True
            return False

        signer = [b for b in blocks if org_matches(b[0])]
        if not signer:
            found = "; ".join(b[0].strip() for b in blocks)
            fail(
                f"no certificate has O={a.expect_publisher!r} — check which "
                f"identity validation the certificate profile was built against. "
                f"Found: {found}"
            )

        leaf = Path(tmp) / "leaf.pem"
        leaf.write_text(signer[0][1] + "\n")
        untrusted = Path(tmp) / "chain.pem"
        untrusted.write_text("\n".join(b[1] for b in blocks) + "\n")
        # -purpose codesign: without it any certificate chaining to the
        # Microsoft root passes, including ones with no code-signing EKU.
        p = subprocess.run(
            ["openssl", "verify", "-CAfile", a.ca_file, "-untrusted",
             str(untrusted), "-purpose", "codesign", str(leaf)],
            capture_output=True, text=True,
        )
        if p.returncode != 0:
            fail(
                "certificate does not chain to the pinned trust anchor: "
                f"{(p.stdout + p.stderr).strip()}"
            )

        print(f"signature ok: {signer[0][0].strip()}")
        print(f"  digest      : {algo} {actual}")
        print("  timestamped : yes")
        print("  chains to   : pinned anchor")


if __name__ == "__main__":
    main()
