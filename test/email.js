const { expect } = require("chai");
const { normalizeEmail } = require("../server/utils/email");

describe("email normalization", function () {
    it("trims and lowercases valid email addresses", function () {
        expect(normalizeEmail("  Voter@Example.COM  ")).to.equal("voter@example.com");
    });

    it("returns null for malformed or non-string emails", function () {
        expect(normalizeEmail("not-an-email")).to.equal(null);
        expect(normalizeEmail(null)).to.equal(null);
    });
});
