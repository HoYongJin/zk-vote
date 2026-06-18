const { expect } = require("chai");
const {
    FIELD_ELEMENT_MODULUS_DEC,
    isFieldElementString,
    parseFieldElement,
} = require("../server/utils/fieldElement");

describe("fieldElement", function () {
    it("normalizes decimal and hex field elements", function () {
        expect(parseFieldElement("123").toString()).to.equal("123");
        expect(parseFieldElement("0x7b").toString()).to.equal("123");
    });

    it("rejects malformed values", function () {
        expect(() => parseFieldElement("not-a-number")).to.throw("non-negative decimal or 0x-hex integer required");
        expect(isFieldElementString("0xzz")).to.equal(false);
    });

    it("rejects values outside the BN254 scalar field", function () {
        expect(() => parseFieldElement(FIELD_ELEMENT_MODULUS_DEC)).to.throw("outside the scalar field");
        expect(isFieldElementString(FIELD_ELEMENT_MODULUS_DEC)).to.equal(false);
    });
});
