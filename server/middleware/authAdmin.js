const supabase = require("../supabaseClient");

/**
 * Middleware to authenticate a request and verify if the user has admin privileges.
 * If successful, it attaches the admin's user object to `req.admin`.
 */
const authAdmin = async (req, res, next) => {
    // 1. Extract JWT from the Authorization header.
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: "AUTHENTICATION_REQUIRED", details: "No token provided." });
    }

    try {
        // 2. Verify the token with Supabase to get the user.
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !user) {
            return res.status(401).json({ error: "INVALID_TOKEN", details: "The provided token is invalid or has expired." });
        }

        // 3. Check if the authenticated user exists in the 'Admins' table.
        const { data: admin, error: adminError } = await supabase
            .from("Admins")
            .select("*")
            .eq("id", user.id)
            .single();

        if (adminError || !admin) {
            return res.status(403).json({ 
                error: "ADMIN_PRIVILEGES_REQUIRED", 
                details: "You do not have the necessary permissions to perform this action." 
            });
        }

        // 4. Attach the admin user object to the request.
        req.admin = admin; // or you could use req.user = user if you prefer

        // 5. If all checks pass, proceed to the next middleware or route handler.
        next();

    } catch (err) {
        console.error("Auth Admin Middleware Error:", err.message);
        if (err.code === 'PGRST116') {    // Specific Supabase error for "No rows found" from .single()
             return res.status(403).json({ 
                error: "ADMIN_PRIVILEGES_REQUIRED", 
                details: "You do not have the necessary permissions to perform this action." 
            });
        }
        return res.status(500).json({ error: "SERVER_ERROR", details: err.message });
    }
};

module.exports = authAdmin;