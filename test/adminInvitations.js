const { expect } = require("chai");
const { withMockedModule } = require("./routeTestUtils");

function loadAdminInvitations(supabaseMock) {
    const restoreSupabase = withMockedModule("../server/supabaseClient", supabaseMock);
    const modulePath = require.resolve("../server/utils/adminInvitations");
    delete require.cache[modulePath];
    const util = require("../server/utils/adminInvitations");

    return {
        ...util,
        cleanup: () => {
            delete require.cache[modulePath];
            restoreSupabase();
        },
    };
}

describe("adminInvitations", function () {
    afterEach(function () {
        if (this.cleanupModule) {
            this.cleanupModule();
            this.cleanupModule = null;
        }
    });

    it("promotes and consumes a pending admin invitation", async function () {
        const calls = [];
        const supabaseMock = {
            from: (table) => {
                const chain = {
                    select: () => chain,
                    eq: (_field, value) => {
                        calls.push({ table, op: "eq", value });
                        return chain;
                    },
                    maybeSingle: async () => ({
                        data: table === "AdminInvitations" ? { email: "admin@example.com" } : null,
                        error: null,
                    }),
                    upsert: async (payload, options) => {
                        calls.push({ table, op: "upsert", payload, options });
                        return { error: null };
                    },
                    delete: () => {
                        calls.push({ table, op: "delete" });
                        return chain;
                    },
                };
                return chain;
            },
        };

        const { promoteInvitedAdmin, cleanup } = loadAdminInvitations(supabaseMock);
        this.cleanupModule = cleanup;

        const result = await promoteInvitedAdmin({ id: "user-1", email: " Admin@Example.com " });

        expect(result).to.deep.equal({ promoted: true, email: "admin@example.com" });
        expect(calls).to.deep.include({
            table: "Admins",
            op: "upsert",
            payload: { id: "user-1" },
            options: { onConflict: "id" },
        });
        expect(calls).to.deep.include({ table: "AdminInvitations", op: "delete" });
    });
});
