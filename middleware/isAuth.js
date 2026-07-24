import jwt from "jsonwebtoken";

export function isAuth(req, res, next) {

  const authHeader = req.get("Authorization");

  if (!authHeader) {
    return res.status(401).json({ message: "Not authenticated." });
  }

  const token = authHeader.split(" ")[1];


  if (!token) {
    return res.status(401).json({ message: "Token missing." });
  }

  try {
    const decodedToken = jwt.verify(token, process.env.JWT_SECRET);

    req.userId = decodedToken.userId;
    req.userEmail = decodedToken.email;
    // Role is embedded in the token at login time (see auth.service.js) so
    // isAdmin doesn't need a DB round-trip on every request.
    req.userRole = decodedToken.role;

    next();
  } catch (error) {
    return res.status(401).json({ message: "invalid or expired token." });
  }
}