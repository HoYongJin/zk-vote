const validator = require("validator");

function normalizeEmail(email) {
    if (typeof email !== "string") {
        return null;
    }

    const normalized = email.trim().toLowerCase();
    return validator.isEmail(normalized) ? normalized : null;
}

module.exports = {
    normalizeEmail,
};
