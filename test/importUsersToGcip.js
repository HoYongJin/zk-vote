const { expect } = require("chai");
const {
    partition,
    isUsableBcrypt,
    toFirebaseRecord,
    chunk,
} = require("../scripts/migration/import-users-to-gcip");

// PROJECT_PLAN Phase 7 — the import script's load-bearing logic (uid=UUID per
// §0.3, emailVerified-from-actual-status per invariant #8, OAuth partition).
// These are pure functions, so they test without firebase-admin or credentials.
describe("import-users-to-gcip", function () {
    describe("isUsableBcrypt", function () {
        it("accepts the bcrypt variants Supabase/GoTrue emits", function () {
            expect(isUsableBcrypt("$2a$10$abcdefghijklmnopqrstuv")).to.equal(true);
            expect(isUsableBcrypt("$2b$12$abcdefghijklmnopqrstuv")).to.equal(true);
            expect(isUsableBcrypt("$2y$10$abcdefghijklmnopqrstuv")).to.equal(true);
        });

        it("rejects missing / non-bcrypt passwords (OAuth-only users)", function () {
            expect(isUsableBcrypt(null)).to.equal(false);
            expect(isUsableBcrypt(undefined)).to.equal(false);
            expect(isUsableBcrypt("")).to.equal(false);
            expect(isUsableBcrypt("plaintext-or-sha256-not-bcrypt")).to.equal(false);
        });
    });

    describe("partition", function () {
        const rows = [
            {
                id: "11111111-1111-1111-1111-111111111111",
                email: "pw@example.com",
                encrypted_password: "$2a$10$saltsaltsaltsaltsaltsahashhashhashhashhashhashhashha",
                email_verified: true,
                providers: ["email"],
            },
            {
                id: "22222222-2222-2222-2222-222222222222",
                email: "kakao@example.com",
                encrypted_password: null,
                email_verified: true,
                providers: ["kakao"],
            },
            {
                id: "33333333-3333-3333-3333-333333333333",
                email: null,
                encrypted_password: null,
                email_verified: false,
                providers: ["kakao"],
            },
        ];

        it("splits password users, OAuth-only users, and no-email rows", function () {
            const { passwordUsers, oauthOnly, skippedNoEmail } = partition(rows);
            expect(passwordUsers.map((u) => u.id)).to.deep.equal([
                "11111111-1111-1111-1111-111111111111",
            ]);
            expect(oauthOnly.map((u) => u.id)).to.deep.equal([
                "22222222-2222-2222-2222-222222222222",
            ]);
            expect(skippedNoEmail.map((u) => u.id)).to.deep.equal([
                "33333333-3333-3333-3333-333333333333",
            ]);
            // The OAuth-only record carries its providers so the Phase-20 cross
            // check can account for it (a documented exclusion, not a silent 401).
            expect(oauthOnly[0].providers).to.deep.equal(["kakao"]);
        });
    });

    describe("toFirebaseRecord", function () {
        it("keeps uid = the Supabase UUID so JWT sub stays a UUID (§0.3)", function () {
            const row = {
                id: "44444444-4444-4444-4444-444444444444",
                email: "a@example.com",
                encrypted_password: "$2b$12$hashhashhashhashhashhashhashhashhashhashhashhashhashha",
                email_verified: true,
            };
            expect(toFirebaseRecord(row).uid).to.equal("44444444-4444-4444-4444-444444444444");
        });

        it("sets emailVerified from ACTUAL status — never unconditionally true (invariant #8)", function () {
            const base = {
                id: "55555555-5555-5555-5555-555555555555",
                email: "b@example.com",
                encrypted_password: "$2a$10$hashhashhashhashhashhashhashhashhashhashhashhashhashha",
            };
            expect(toFirebaseRecord({ ...base, email_verified: true }).emailVerified).to.equal(true);
            expect(toFirebaseRecord({ ...base, email_verified: false }).emailVerified).to.equal(
                false
            );
            // A non-boolean/absent source value must NOT promote to verified.
            expect(toFirebaseRecord({ ...base, email_verified: undefined }).emailVerified).to.equal(
                false
            );
        });

        it("passes the raw bcrypt hash as UTF-8 bytes for the BCRYPT algorithm", function () {
            const hash = "$2a$10$saltsaltsaltsaltsaltsahashhashhashhashhashhashhashha";
            const record = toFirebaseRecord({
                id: "66666666-6666-6666-6666-666666666666",
                email: "c@example.com",
                encrypted_password: hash,
                email_verified: true,
            });
            expect(Buffer.isBuffer(record.passwordHash)).to.equal(true);
            expect(record.passwordHash.toString("utf8")).to.equal(hash);
        });
    });

    describe("chunk", function () {
        it("batches to the Firebase 1000/call import cap", function () {
            const items = Array.from({ length: 2300 }, (_, i) => i);
            const batches = chunk(items, 1000);
            expect(batches.map((b) => b.length)).to.deep.equal([1000, 1000, 300]);
        });
    });
});
