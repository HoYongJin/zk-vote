/**
 * @file server/middleware/authAdmin.js
 * @desc Admin authentication middleware.
 * Verifies the JWT, checks if the user ID exists in the 'Admins' table,
 * and attaches both `req.user` (Supabase user) and `req.admin` (Admin profile).
 */

const supabase = require("../supabaseClient");

/**
 * Express middleware to authenticate a request and verify admin privileges.
 * This function performs two checks:
 * 1. Verifies the Supabase JWT (identical to the `auth` middleware).
 * 2. Checks if the authenticated user's ID exists in the 'Admins' table.
 *
 * If successful, it attaches *both* the standard Supabase user object to `req.user`
 * (for consistency with `auth` middleware) and the admin profile to `req.admin`.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @param {import('express').NextFunction} next - The Express next middleware function.
 */
const authAdmin = async (req, res, next) => {
    try {
        // 1. Extract the JWT from the Authorization: "Bearer <token>" header.
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        // If no token is provided, return a 401 Unauthorized error.
        if (!token) {
            return res.status(401).json({ 
                error: "AUTHENTICATION_REQUIRED", 
                details: "No token provided." 
            });
        }

        // 2. Verify the token with Supabase to get the user data.
        const { data: { user }, error } = await supabase.auth.getUser(token);

        // If the token is invalid (e.g., expired) or no user is found, return 401.
        if (error || !user) {
            return res.status(401).json({ 
                error: "INVALID_TOKEN", 
                details: "The provided token is invalid or has expired." 
            });
        }

        // 3. Check if the authenticated user exists in the 'Admins' table.
        const { data: admin, error: adminError } = await supabase
            .from("Admins")
            .select("*")
            .eq("id", user.id)
            .single();

        // 4. Handle errors or if the user is not found in the 'Admins' table.
        //    (adminError) handles DB errors
        //    (!admin) handles the case where the user is valid but not an admin.
        if (adminError || !admin) {
            return res.status(403).json({ 
                error: "ADMIN_PRIVILEGES_REQUIRED", 
                details: "You do not have the necessary permissions to perform this action." 
            });
        }

        // 5. Attach both user and admin objects to the request for downstream use.
        req.user = user;   // The standard Supabase user object
        req.admin = admin; // The user's profile from the 'Admins' table
        
        // 6. If all checks pass, proceed to the next middleware or route handler.
        next();

    } catch (err) {
        // Handle unexpected server errors.
        console.error("Auth Admin Middleware Error:", err.message);
        return res.status(500).json({ 
            error: "SERVER_ERROR", 
            details: "An unexpected error occurred during admin authentication."
        });
    }
};

module.exports = authAdmin;