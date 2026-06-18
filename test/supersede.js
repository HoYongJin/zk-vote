const { expect } = require("chai");
const {
    filterSupersededElections,
    isElectionSuperseded,
    isMissingOptionalColumnError,
    listSupersededElectionIds,
    loadSupersededAt,
} = require("../server/utils/supersede");

function supabaseFor(result, calls = {}) {
    const chain = {
        select: () => chain,
        eq: () => chain,
        in: (column, values) => {
            calls.in = { column, values };
            return chain;
        },
        not: () => chain,
        single: async () => result,
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
    return { from: () => chain };
}

describe("supersede helper", function () {
    it("detects superseded elections when the optional column exists", async function () {
        const supabase = supabaseFor({
            data: { superseded_at: "2026-06-12T00:00:00.000Z" },
            error: null,
        });

        expect(await isElectionSuperseded(supabase, "election-1")).to.equal(true);
    });

    it("treats missing optional superseded_at column as not superseded", async function () {
        const supabase = supabaseFor({
            data: null,
            error: { code: "PGRST204", message: "Could not find the 'superseded_at' column" },
        });

        expect(await loadSupersededAt(supabase, "election-1")).to.equal(null);
        expect(await isElectionSuperseded(supabase, "election-1")).to.equal(false);
    });

    it("does not mask unrelated column errors as an optional superseded_at migration", function () {
        expect(isMissingOptionalColumnError({
            code: "42703",
            message: 'column "superseded_at" does not exist',
        })).to.equal(true);
        expect(isMissingOptionalColumnError({
            code: "42703",
            message: 'column "completed" does not exist',
        })).to.equal(false);
    });

    it("filters superseded elections from Node fallback lists", async function () {
        const calls = {};
        const supabase = supabaseFor({
            data: [
                { id: "election-2", superseded_at: "2026-06-12T00:00:00.000Z" },
            ],
            error: null,
        }, calls);

        expect(Array.from(await listSupersededElectionIds(supabase))).to.deep.equal(["election-2"]);
        expect(await filterSupersededElections(supabase, [
            { id: "election-1" },
            { id: "election-2" },
            { id: "election-2" },
        ])).to.deep.equal([{ id: "election-1" }]);
        expect(calls.in).to.deep.equal({ column: "id", values: ["election-1", "election-2"] });
    });
});
