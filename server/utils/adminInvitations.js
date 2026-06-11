const supabase = require("../supabaseClient");
const { normalizeEmail } = require("./email");

async function promoteInvitedAdmin(user) {
    const normalizedEmail = normalizeEmail(user?.email);
    if (!user?.id || !normalizedEmail) {
        return { promoted: false };
    }

    const { data: invitation, error: invitationError } = await supabase
        .from("AdminInvitations")
        .select("email")
        .eq("email", normalizedEmail)
        .maybeSingle();

    if (invitationError) {
        throw invitationError;
    }
    if (!invitation) {
        return { promoted: false };
    }

    const { error: adminError } = await supabase
        .from("Admins")
        .upsert({ id: user.id }, { onConflict: "id" });

    if (adminError) {
        throw adminError;
    }

    const { error: deleteError } = await supabase
        .from("AdminInvitations")
        .delete()
        .eq("email", normalizedEmail);

    if (deleteError) {
        throw deleteError;
    }

    return { promoted: true, email: normalizedEmail };
}

module.exports = {
    promoteInvitedAdmin,
};
