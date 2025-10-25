/**
 * @file server/middleware/auth.js
 * @desc General authentication middleware for all logged-in users.
 * Verifies the Supabase JWT from the Authorization header and attaches
 * the authenticated user object to `req.user`.
 */

const supabase = require("../supabaseClient");

/**
 * Express middleware to authenticate a request using a Supabase JWT.
 * This function checks for a 'Bearer' token, validates it with Supabase,
 * and attaches the resulting user object to `req.user` if valid.
 *
 * This middleware is intended for routes that require *any* authenticated user.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @param {import('express').NextFunction} next - The Express next middleware function.
 */
const auth = async (req, res, next) => {
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

        // 3. Attach the authenticated Supabase user object to the request.
        req.user = user;

        // 4. If all checks pass, proceed to the next middleware or route handler.
        next();

    } catch (err) {
        // Handle unexpected server errors.
        console.error("Authentication Middleware Error:", err.message);
        return res.status(500).json({ 
            error: "SERVER_ERROR", 
            details: "An error occurred during authentication." 
        });
    }
};

module.exports = auth;