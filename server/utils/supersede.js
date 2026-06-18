function isMissingOptionalColumnError(error) {
    const message = error?.message || "";
    return error && (
        (error.code === "PGRST204" && /superseded_at|schema cache/i.test(message)) ||
        (error.code === "42703" && /superseded_at/i.test(message)) ||
        /superseded_at.*schema cache|schema cache.*superseded_at/i.test(message)
    );
}

async function loadSupersededAt(supabase, electionId) {
    const { data, error } = await supabase
        .from("Elections")
        .select("superseded_at")
        .eq("id", electionId)
        .single();

    if (error) {
        if (isMissingOptionalColumnError(error) || error.code === "PGRST116") {
            return null;
        }
        throw error;
    }

    return data?.superseded_at || null;
}

async function isElectionSuperseded(supabase, electionId) {
    return Boolean(await loadSupersededAt(supabase, electionId));
}

async function listSupersededElectionIds(supabase, electionIds = []) {
    const uniqueElectionIds = Array.from(new Set((electionIds || []).filter(Boolean)));
    let query = supabase
        .from("Elections")
        .select("id, superseded_at")
        .not("superseded_at", "is", null);

    if (uniqueElectionIds.length > 0) {
        query = query.in("id", uniqueElectionIds);
    }

    const { data, error } = await query;

    if (error) {
        if (isMissingOptionalColumnError(error)) {
            return new Set();
        }
        throw error;
    }

    return new Set((data || []).map((row) => row.id).filter(Boolean));
}

async function filterSupersededElections(supabase, elections) {
    if (!Array.isArray(elections) || elections.length === 0) {
        return elections || [];
    }
    const supersededIds = await listSupersededElectionIds(supabase, elections.map((election) => election.id));
    if (supersededIds.size === 0) {
        return elections;
    }
    return elections.filter((election) => !supersededIds.has(election.id));
}

module.exports = {
    filterSupersededElections,
    isElectionSuperseded,
    isMissingOptionalColumnError,
    listSupersededElectionIds,
    loadSupersededAt,
};
