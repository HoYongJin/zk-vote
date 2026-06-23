const FIELD_ELEMENT_MODULUS_DEC = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
const FIELD_ELEMENT_MODULUS = BigInt(FIELD_ELEMENT_MODULUS_DEC);

interface FieldElementError extends Error {
    code: string;
    status: number;
}

function isIntegerLike(value: unknown): boolean {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0;
    }
    return typeof value === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value);
}

function fieldElementError(fieldName: string, reason: string): FieldElementError {
    return Object.assign(new Error(`${fieldName} must be a valid BN254 field element (${reason}).`), {
        code: "INVALID_PAYLOAD",
        status: 400,
    });
}

function parseFieldElement(value: unknown, fieldName = "field element"): bigint {
    if (!isIntegerLike(value)) {
        throw fieldElementError(fieldName, "non-negative decimal or 0x-hex integer required");
    }
    const parsed = BigInt(value as string | number);
    if (parsed >= FIELD_ELEMENT_MODULUS) {
        throw fieldElementError(fieldName, "value is outside the scalar field");
    }
    return parsed;
}

function isFieldElementString(value: unknown): boolean {
    try {
        parseFieldElement(value);
        return true;
    } catch (_) {
        return false;
    }
}

export {
    FIELD_ELEMENT_MODULUS_DEC,
    isIntegerLike,
    isFieldElementString,
    parseFieldElement,
};
