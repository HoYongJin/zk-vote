import { describe, it, expect } from "vitest";
import {
    FIELD_ELEMENT_MODULUS_DEC,
    isFieldElementString,
    parseFieldElement,
} from "../scripts/migration/fieldElement";

describe("fieldElement", function () {
    it("normalizes decimal and hex field elements", function () {
        expect(parseFieldElement("123").toString()).toBe("123");
        expect(parseFieldElement("0x7b").toString()).toBe("123");
    });

    it("rejects malformed values", function () {
        expect(() => parseFieldElement("not-a-number")).toThrow("non-negative decimal or 0x-hex integer required");
        expect(isFieldElementString("0xzz")).toBe(false);
    });

    it("rejects values outside the BN254 scalar field", function () {
        expect(() => parseFieldElement(FIELD_ELEMENT_MODULUS_DEC)).toThrow("outside the scalar field");
        expect(isFieldElementString(FIELD_ELEMENT_MODULUS_DEC)).toBe(false);
    });
});
